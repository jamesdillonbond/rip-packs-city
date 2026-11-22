// app/api/ingest/candy-chain-sales/route.ts
//
// Candy sales that settle OFF Magic Eden, read from the Solana chain (lib/candy/chain-sales.ts;
// 2026-11-22). Hourly: walks every Candy collection account's new signatures (oldest-walked first),
// decodes fills on program 7Aru… (marketplace `solana_7aru`) and offers them to the same drain queue
// the Magic Eden lanes use; candy-sales-indexer (:20) writes them into `sales`.
// Vercel cron (GET, CRON_SECRET) or an operator (INGEST_SECRET_TOKEN).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { bearerMatches } from "@/lib/auth/bearer-secret"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { runCandyChainSales } from "@/lib/candy/chain-sales"
import { CANDY_MLB_SLUG } from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-chain-sales"
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

  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: t0, collectionSlug: CANDY_MLB_SLUG })

  let result
  try {
    result = await runCandyChainSales(supabaseAdmin, { budgetMs: BUDGET_MS })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log(startedAt, 0, 0, false, msg.slice(0, 500), { duration_ms: Date.now() - t0 })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
  // The per-collection list is long; keep only the ones that found a fill or failed.
  const { collections, ...rest } = result
  const extra = {
    duration_ms: Date.now() - t0,
    ...rest,
    collections: collections.filter((c) => c.fills > 0 || (c.error && c.error !== "budget")),
  }
  // rows_found = fills decoded; rows_written = fills newly offered to the drain queue (landed).
  await log(startedAt, result.fills_seen, result.fills_offered, result.ok, result.error, extra)
  return NextResponse.json(extra, { status: result.ok ? 200 : 207 })
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
