// app/api/ingest/candy-opensea-chain-bids/route.ts
//
// Candy offers on OpenSea, read from the Solana chain with no API key (lib/candy/opensea-chain-bids.ts; 2026-11-24).
// Hourly: one getProgramAccounts census of OpenSea's Solana marketplace program's BidState accounts → the single-card
// bids on Candy cards whose SOL the account itself holds → candy_offers (venue 'opensea'); every OpenSea offer this
// sweep did not confirm is retired, behind a plausible census. Collection-wide bids are counted, not written. The older
// key-based /api/candy-opensea-offers-indexer is unscheduled (no OPENSEA_API_KEY); do not run both.
// Vercel cron (GET, CRON_SECRET) or an operator (INGEST_SECRET_TOKEN).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { bearerMatches } from "@/lib/auth/bearer-secret"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { runOpenSeaChainBids } from "@/lib/candy/opensea-chain-bids"
import { solUsd } from "@/lib/chains/solana/das"
import { CANDY_MLB_SLUG } from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 180

const PIPELINE_NAME = "candy-opensea-chain-bids"

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

// The last successful run's census size — the plausibility floor for retirement. NULL when unknown (first run, or a
// failed read): the fixed minimum still applies.
async function previousAccounts(): Promise<number | null> {
  try {
    const { data, error } = await (supabaseAdmin as any)
      .from("pipeline_runs")
      .select("extra")
      .eq("pipeline", PIPELINE_NAME)
      .eq("ok", true)
      .not("rows_found", "is", null)
      .order("started_at", { ascending: false })
      .limit(1)
    if (error) return null
    const n = Number((data ?? [])[0]?.extra?.accounts)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

async function handle(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: t0, collectionSlug: CANDY_MLB_SLUG })

  let report
  try {
    report = await runOpenSeaChainBids(supabaseAdmin, {
      solUsd: async () => solUsd(),
      previousAccounts: await previousAccounts(),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log(startedAt, null, null, false, msg.slice(0, 500), { duration_ms: Date.now() - t0 })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
  const extra = { duration_ms: Date.now() - t0, ...report }
  // rows_found = single-card OpenSea bids on Candy cards; rows_written = offers upserted (landed).
  await log(startedAt, report.candy_matched, report.written, report.ok, report.error, extra)
  return NextResponse.json(extra, { status: report.ok ? 200 : 207 })
}

async function log(startedAt: string, found: number | null, written: number | null, ok: boolean, error: string | null, extra: Record<string, unknown>) {
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
