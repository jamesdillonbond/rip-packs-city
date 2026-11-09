// app/api/ingest/candy-collections-census/route.ts
//
// Hourly rotating census of every catalogued Candy collection outside the five registry
// sets (lib/candy/collections-census.ts). Vercel cron (GET, CRON_SECRET) or an operator
// (INGEST_SECRET_TOKEN). Each run walks DAS pages for ~10 minutes and keeps its place in
// candy_collections, so the ~1,400 pages cycle in a few hours.
//
// A heartbeat row is written BEFORE the work, so a run killed at the wall reads as
// "reached, did not finish" rather than as an absence.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { bearerMatches } from "@/lib/auth/bearer-secret"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { runCollectionsCensus } from "@/lib/candy/collections-census"
import { candyDiscoveryReady, CANDY_MLB_SLUG } from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 800

const PIPELINE_NAME = "candy-collections-census"
const BUDGET_MS = 600_000

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
    result = await runCollectionsCensus(supabaseAdmin, { budgetMs: BUDGET_MS })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log(startedAt, 0, 0, false, msg.slice(0, 500), { duration_ms: Date.now() - t0 })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
  const extra = {
    duration_ms: Date.now() - t0,
    pages: result.pages,
    cards: result.cards,
    wmc_inserted: result.wmc_inserted,
    editions_inserted: result.editions_inserted,
    // 2026-11-09: assets DAS returned without their off-chain JSON (lib/chains/solana/hydrate.ts)
    hydrated_fetched: result.hydrated_fetched,
    hydrated_reused: result.hydrated_reused,
    unhydrated_skipped: result.unhydrated_skipped,
    wmc_repointed: result.wmc_repointed,
    hydrate_fail_reasons: result.hydrate_fail_reasons,
    hydrate_fetches: result.hydrate_fetches,
    unhydrated_sample: result.unhydrated_sample,
    collections_touched: result.collections.length,
    collections_completed: result.completed,
    escrow_remapped: result.escrow_remapped,
    ghosts_purged: result.ghosts_purged,
    collections: result.collections.slice(0, 40),
  }
  await log(startedAt, result.cards, result.wmc_inserted, result.ok, result.error, extra)
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
