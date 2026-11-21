// app/api/ingest/candy-collections-sales/route.ts
//
// HOURLY sales pass over every non-registry Candy collection (lib/candy/collections-sales-pass.ts):
// each collection's new Magic Eden sales since its high-water mark, offered to the sales
// indexer's drain, most-recently-active collections first. Runs at :05; candy-sales-indexer runs
// at :20 and writes them, so a Candy sale reaches `sales` within ~1.5 h instead of ~6 h (median)
// / 25 h (worst) through the rotating market lane alone (measured 11-14 → 11-21).
// Vercel cron (GET, CRON_SECRET) or an operator (INGEST_SECRET_TOKEN).
//
// A heartbeat row is written BEFORE the work, so a run killed at the wall reads as
// "reached, did not finish" rather than as an absence.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { bearerMatches } from "@/lib/auth/bearer-secret"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { runCollectionsSalesPass } from "@/lib/candy/collections-sales-pass"
import { candyDiscoveryReady, CANDY_MLB_SLUG } from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-collections-sales"
const BUDGET_MS = 240_000

function authed(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? ""
  if (process.env.INGEST_SECRET_TOKEN && bearerMatches(header, "INGEST_SECRET_TOKEN")) return true
  if (process.env.CRON_SECRET && bearerMatches(header, "CRON_SECRET")) return true
  return false
}

export async function GET(req: NextRequest) {
  return handle(req)
}
export async function POST(req: NextRequest) {
  return handle(req)
}

async function handle(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!candyDiscoveryReady()) return NextResponse.json({ skipped: "discovery_pending" }, { status: 202 })

  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: t0, collectionSlug: CANDY_MLB_SLUG })

  let result
  try {
    result = await runCollectionsSalesPass(supabaseAdmin, { budgetMs: BUDGET_MS })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log(startedAt, 0, 0, false, msg.slice(0, 500), { duration_ms: Date.now() - t0 })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
  const extra = {
    duration_ms: Date.now() - t0,
    queued: result.queued,
    checked: result.checked,
    skipped_no_high_water: result.skipped_no_high_water,
    not_reached: result.not_reached,
    budget_stopped: result.budget_stopped,
    sales_seen: result.sales_seen,
    sales_offered: result.sales_offered,
    high_water_advanced: result.high_water_advanced,
    incomplete: result.incomplete,
    collections: result.collections.filter((c) => c.sales_seen > 0 || c.error || c.incomplete).slice(0, 40),
  }
  // rows_written = sales actually offered to the drain queue (each one a landed write).
  await log(startedAt, result.checked, result.sales_offered, result.ok, result.error, extra)
  return NextResponse.json({ ok: result.ok, ...extra, error: result.error }, { status: result.ok ? 200 : 207 })
}

async function log(startedAt: string, found: number, written: number, ok: boolean, error: string | null, extra: Record<string, unknown>) {
  try {
    const { error: logErr } = await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: found,
      p_rows_written: written,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: error,
      p_collection_slug: CANDY_MLB_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: extra,
    })
    if (logErr) console.log(`[${PIPELINE_NAME}] log_pipeline_run err: ${logErr.message}`)
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] log_pipeline_run threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}
