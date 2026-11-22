// app/api/ingest/candy-sales-buyer-paid/route.ts
//
// Re-prices Candy `sales` from the LISTED price to WHAT THE BUYER PAID, read per transaction from
// the Solana chain (lib/candy/sale-buyer-paid.ts; Trevor 2026-11-21). Every 5 minutes: newest
// unpriced sales first, so a new sale is corrected within minutes of the hourly indexer writing it,
// and the 18.7k-sale history is worked through behind it. Keyless public RPC, paced; a run that is
// rate-limited stops early and says so (`rate_limited`), and the next run resumes.
// Vercel cron (GET, CRON_SECRET) or an operator (INGEST_SECRET_TOKEN).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { bearerMatches } from "@/lib/auth/bearer-secret"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { runCandyBuyerPaid } from "@/lib/candy/sale-buyer-paid"
import { CANDY_MLB_SLUG } from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-sales-buyer-paid"
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
    result = await runCandyBuyerPaid(supabaseAdmin, { budgetMs: BUDGET_MS })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log(startedAt, 0, 0, false, msg.slice(0, 500), { duration_ms: Date.now() - t0 })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
  const extra = { duration_ms: Date.now() - t0, ...result }
  // A run that read nothing because every call was refused did NOT work, even with no error.
  const ok = result.ok && !(result.targets > 0 && result.read === 0 && result.rate_limited > 0)
  const error = result.error ?? (ok ? null : `rate_limited: 0 of ${result.targets} transactions read`)
  // rows_written = sales actually re-priced (landed writes only).
  await log(startedAt, result.read, result.applied, ok, error, extra)
  return NextResponse.json({ ...extra, ok, error }, { status: ok ? 200 : 207 })
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
