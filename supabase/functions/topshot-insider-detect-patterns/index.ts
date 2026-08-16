// topshot-insider-detect-patterns
//
// Reads topshot_insider_buybacks over the last 24 hours and emits
// topshot_insider_alerts when one of three patterns matches:
//
//   1. cluster_buyback   — a single player has 5+ buybacks in 24h.
//   2. set_concentration — a single set has 10+ buybacks in 24h.
//   3. low_serial_buyback — any buyback whose serial_number is in the
//      bottom 5% of the edition's mint count (e.g. serial 12 of 2500).
//
// Dedup: each alert type carries an evidence_jsonb array of buyback ids.
// Before emitting, we check whether an active alert already covers the
// same evidence set; if it does, we skip rather than duplicate. expires_at
// is 72h from generated_at on every alert.

import { createClient } from "@supabase/supabase-js"
import {
  computeInsiderAlerts,
  type InsiderAlertType,
  type InsiderBuyback,
} from "../_shared/insider-detect.ts"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const FUNCTION_VERSION = 1
const PIPELINE = "topshot-insider-detect-patterns"
const COLLECTION_SLUG = "nba_top_shot"
const ALERT_TTL_HOURS = 72

interface BuybackRow {
  id: string
  buyer_address: string
  edition_id: string | null
  moment_id: string | null
  serial_number: number | null
  sold_at: string
  // Joined columns
  player_name: string | null
  set_name: string | null
  edition_circulation: number | null
}

async function loadRecentBuybacks(): Promise<BuybackRow[]> {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (supabase as any)
    .from("topshot_insider_buybacks")
    .select(`
      id, buyer_address, edition_id, moment_id, serial_number, sold_at,
      editions:edition_id (player_name, set_name, circulation_count)
    `)
    .gte("sold_at", sinceIso)
    // MARKETPLACE ONLY. The direct_transfer arm of this table is produced by
    // diffing daily wallet-holdings snapshots, and that walk paged
    // wallet_moments_cache with no ORDER BY, so the wallet's own stock dropped
    // out of one snapshot and reappeared in the next. Measured 2026-08-16:
    // 41,301 of 41,307 distinct moments it reported as "acquired" were ALREADY
    // HELD on the first snapshot, and ~6,500 land per day carrying TODAY's
    // date -- exactly the 24h window this detector reads.
    //
    // This detector is DORMANT (no cron caller, zero pipeline_runs, zero alerts
    // of its three types ever), so this is latent rather than live. The filter
    // is here so a revival cannot publish fabricated insider alerts; that it
    // emitted nothing so far is luck -- artifact rows carry a NULL
    // serial_number -- not design.
    .eq("acquisition_method", "marketplace")
    .order("sold_at", { ascending: false })

  if (error) {
    console.log(`[${PIPELINE}] loadRecentBuybacks err: ${error.message}`)
    return []
  }
  // deno-lint-ignore no-explicit-any
  const rows = ((data ?? []) as any[]).map(r => ({
    id: r.id,
    buyer_address: r.buyer_address,
    edition_id: r.edition_id,
    moment_id: r.moment_id,
    serial_number: r.serial_number,
    sold_at: r.sold_at,
    player_name: r.editions?.player_name ?? null,
    set_name: r.editions?.set_name ?? null,
    edition_circulation: r.editions?.circulation_count ?? null,
  })) as BuybackRow[]
  return rows
}

// Load the evidence sets of all active (last-24h) alerts, grouped by type, so the
// pure detector can apply its overlap-dedup without a per-candidate DB round-trip.
async function loadActiveEvidenceByType(): Promise<Partial<Record<InsiderAlertType, string[][]>>> {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (supabase as any)
    .from("topshot_insider_alerts")
    .select("alert_type, evidence_jsonb, generated_at")
    .gte("generated_at", sinceIso)

  const byType: Partial<Record<InsiderAlertType, string[][]>> = {}
  if (error || !data) return byType
  // deno-lint-ignore no-explicit-any
  for (const row of data as any[]) {
    const t = row.alert_type as InsiderAlertType
    const evidence: string[] = Array.isArray(row.evidence_jsonb) ? row.evidence_jsonb : []
    ;(byType[t] ??= []).push(evidence)
  }
  return byType
}

async function insertAlert(args: {
  alert_type: "cluster_buyback" | "low_serial_buyback" | "set_concentration"
  title: string
  summary: string
  evidence: string[]
  severity: number
}) {
  const expiresAt = new Date(Date.now() + ALERT_TTL_HOURS * 60 * 60 * 1000).toISOString()
  // deno-lint-ignore no-explicit-any
  const { error } = await (supabase as any)
    .from("topshot_insider_alerts")
    .insert({
      alert_type: args.alert_type,
      title: args.title,
      summary: args.summary,
      evidence_jsonb: args.evidence,
      severity: args.severity,
      expires_at: expiresAt,
    })
  if (error) console.log(`[${PIPELINE}] insertAlert err: ${error.message}`)
}

async function logRun(args: {
  startedAt: string
  rowsFound: number
  rowsWritten: number
  ok: boolean
  error?: string | null
  extra: Record<string, unknown>
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: 0,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch (err) {
    console.log(`[${PIPELINE}] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function runWork(startedAtIso: string, started: number) {
  const buybacks = await loadRecentBuybacks()
  if (buybacks.length === 0) {
    await logRun({
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, ok: true,
      extra: {
        function_version: FUNCTION_VERSION,
        message: "no_recent_buybacks",
        elapsed_ms: Date.now() - started,
      },
    })
    return
  }

  // Pure detection (grouping / thresholds / severity / dedup) lives in
  // ../_shared/insider-detect.ts, which is unit-tested under vitest. This edge
  // function is now just I/O: load buybacks + active-alert evidence, run the
  // detector, persist what it returns.
  const existingByType = await loadActiveEvidenceByType()
  const { alerts, playersWithBuybacks, setsWithBuybacks } = computeInsiderAlerts(
    buybacks as InsiderBuyback[],
    existingByType,
  )

  let alertsGenerated = 0
  for (const alert of alerts) {
    await insertAlert(alert)
    alertsGenerated++
  }

  await logRun({
    startedAt: startedAtIso,
    rowsFound: buybacks.length,
    rowsWritten: alertsGenerated,
    ok: true,
    extra: {
      function_version: FUNCTION_VERSION,
      buybacks_analyzed: buybacks.length,
      alerts_generated: alertsGenerated,
      players_with_buybacks: playersWithBuybacks,
      sets_with_buybacks: setsWithBuybacks,
      elapsed_ms: Date.now() - started,
    },
  })
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime
  const workPromise = runWork(startedAtIso, started)
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(workPromise)
  } else {
    workPromise.catch(e => console.log(`[${PIPELINE}] waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`))
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "queued",
      started_at: startedAtIso,
      function_version: FUNCTION_VERSION,
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
