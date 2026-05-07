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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

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

async function activeAlertCovers(alertType: string, evidenceSorted: string[]): Promise<boolean> {
  // An "active" alert is generated_at within the last 24h. We treat an
  // alert as already-covering this evidence set if its evidence_jsonb
  // contains a strict superset / overlap of the same buyback ids — the
  // simple conservative check is "are any of these ids already in any
  // active alert of the same type?". That keeps the pattern detector
  // from spamming alerts when a cluster grows from 5 → 6 → 7 over a few
  // hours; the original alert at 5 still covers the situation.
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (supabase as any)
    .from("topshot_insider_alerts")
    .select("id, evidence_jsonb, generated_at")
    .eq("alert_type", alertType)
    .gte("generated_at", sinceIso)

  if (error || !data) return false
  // deno-lint-ignore no-explicit-any
  for (const row of data as any[]) {
    const existing: string[] = Array.isArray(row.evidence_jsonb) ? row.evidence_jsonb : []
    const overlap = existing.some(id => evidenceSorted.includes(id))
    if (overlap) return true
  }
  return false
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

  let alertsGenerated = 0

  // ── 1. cluster_buyback (player) ──────────────────────────────────────
  const byPlayer = new Map<string, BuybackRow[]>()
  for (const b of buybacks) {
    if (!b.player_name) continue
    const list = byPlayer.get(b.player_name) ?? []
    list.push(b)
    byPlayer.set(b.player_name, list)
  }
  for (const [player, rows] of byPlayer.entries()) {
    if (rows.length < 5) continue
    const evidence = rows.map(r => r.id).sort()
    if (await activeAlertCovers("cluster_buyback", evidence)) continue
    const summaryLines = rows.slice(0, 8).map(r =>
      `• ${r.set_name ?? "?"} #${r.serial_number ?? "?"} (${new Date(r.sold_at).toUTCString()})`
    )
    await insertAlert({
      alert_type: "cluster_buyback",
      title: `Top Shot bought ${rows.length} ${player} moments in 24h`,
      summary: summaryLines.join("\n") + (rows.length > 8 ? `\n…and ${rows.length - 8} more` : ""),
      evidence,
      severity: rows.length >= 10 ? 5 : rows.length >= 7 ? 4 : 3,
    })
    alertsGenerated++
  }

  // ── 2. set_concentration ──────────────────────────────────────────────
  const bySet = new Map<string, BuybackRow[]>()
  for (const b of buybacks) {
    if (!b.set_name) continue
    const list = bySet.get(b.set_name) ?? []
    list.push(b)
    bySet.set(b.set_name, list)
  }
  for (const [setName, rows] of bySet.entries()) {
    if (rows.length < 10) continue
    const evidence = rows.map(r => r.id).sort()
    if (await activeAlertCovers("set_concentration", evidence)) continue
    const playerSet = new Set(rows.map(r => r.player_name).filter(Boolean))
    await insertAlert({
      alert_type: "set_concentration",
      title: `Top Shot bought ${rows.length} moments from ${setName} in 24h`,
      summary: `${rows.length} buybacks from "${setName}" across ${playerSet.size} player(s) in the last 24 hours.`,
      evidence,
      severity: rows.length >= 25 ? 5 : rows.length >= 15 ? 4 : 3,
    })
    alertsGenerated++
  }

  // ── 3. low_serial_buyback ─────────────────────────────────────────────
  for (const b of buybacks) {
    if (!b.serial_number || !b.edition_circulation || b.edition_circulation <= 0) continue
    const threshold = Math.max(5, Math.ceil(b.edition_circulation * 0.05))
    if (b.serial_number > threshold) continue
    const evidence = [b.id]
    if (await activeAlertCovers("low_serial_buyback", evidence)) continue
    await insertAlert({
      alert_type: "low_serial_buyback",
      title: `Top Shot bought ${b.player_name ?? "a"} ${b.set_name ?? "moment"} #${b.serial_number} of ${b.edition_circulation}`,
      summary: `Low-serial buyback in the bottom ${Math.round((b.serial_number / b.edition_circulation) * 100)}% of the edition. Bought ${new Date(b.sold_at).toUTCString()}.`,
      evidence,
      severity: b.serial_number === 1 ? 5 : b.serial_number <= 10 ? 4 : 3,
    })
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
      players_with_buybacks: byPlayer.size,
      sets_with_buybacks: bySet.size,
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
