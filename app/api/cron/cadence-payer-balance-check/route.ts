// app/api/cron/cadence-payer-balance-check/route.ts
//
// Health check for the Cadence service payer wallet (0x73f55c4450b8d466).
// Reads the FLOW balance via Flow REST /v1/accounts and emits a
// pipeline_runs row with ok=false when balance drops below the alert
// threshold (default 0.05 FLOW) so the watchlist alerting layer fires
// at the source rather than downstream where every script signing
// attempt produces an INSUFFICIENT_GAS_FUNDS error.
//
// Schedule cron-job.org every 30min. Bearer INGEST_SECRET_TOKEN or ?token=.
//
// Note: the Flow public REST endpoint accepts public reads without auth,
// but Cloudflare blocks Vercel egress for some endpoints — accounts is
// known-good from Vercel as of 2026-05-17.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const PIPELINE_NAME = "cadence-payer-balance-check"
const PAYER_ADDR = "0x73f55c4450b8d466"
const ALERT_THRESHOLD_FLOW = 0.05
// Flow stores balance as UFix64 (8-decimal fixed-point). REST returns it
// as a stringified UFix64 like "12.34000000".
function ufix64ToNumber(raw: unknown): number {
  if (raw == null) return NaN
  const n = Number(String(raw))
  return Number.isFinite(n) ? n : NaN
}

function authorized(req: NextRequest): boolean {
  const expected = process.env.INGEST_SECRET_TOKEN
  const cronSecret = process.env.CRON_SECRET
  if (!expected) return false
  const bearer = req.headers.get("authorization") ?? ""
  if (bearer.startsWith("Bearer ")) {
    const tok = bearer.slice(7)
    if (tok === expected) return true
    if (cronSecret && tok === cronSecret) return true
  }
  const qp = req.nextUrl.searchParams.get("token")
  return qp === expected
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()
  const thresholdParam = Number(req.nextUrl.searchParams.get("threshold_flow"))
  const threshold = Number.isFinite(thresholdParam) && thresholdParam > 0
    ? thresholdParam
    : ALERT_THRESHOLD_FLOW

  let balanceFlow: number = NaN
  let ok = true
  let errMsg: string | null = null
  let httpStatus = 0

  try {
    const url = `https://rest-mainnet.onflow.org/v1/accounts/${PAYER_ADDR}?block_height=sealed`
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
    httpStatus = res.status
    if (!res.ok) {
      ok = false
      errMsg = `flow rest HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
    } else {
      const json = (await res.json()) as { balance?: string }
      // Flow REST returns balance as UFix64 string-of-cents (e.g. "1000000"
      // representing 0.01 FLOW). The /v1/accounts endpoint uses the
      // "balance" field in UFix64 *cents* (raw uint64), so we divide by 1e8.
      const rawBalance = Number(json.balance ?? "0")
      if (!Number.isFinite(rawBalance)) {
        ok = false
        errMsg = `unparseable balance: ${JSON.stringify(json.balance)}`
      } else {
        balanceFlow = rawBalance / 1e8
        if (balanceFlow < threshold) {
          ok = false
          errMsg = `payer balance ${balanceFlow.toFixed(6)} FLOW below alert threshold ${threshold} FLOW — top up ${PAYER_ADDR}`
        }
      }
    }
  } catch (e) {
    ok = false
    errMsg = e instanceof Error ? e.message : String(e)
  }

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: 1,
      p_rows_written: 0,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errMsg,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        payer_address: PAYER_ADDR,
        balance_flow: Number.isFinite(balanceFlow) ? balanceFlow : null,
        threshold_flow: threshold,
        http_status: httpStatus,
        duration_ms: Date.now() - startedMs,
      },
    })
  } catch (e) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  return NextResponse.json({
    ok,
    error: errMsg,
    payer_address: PAYER_ADDR,
    balance_flow: Number.isFinite(balanceFlow) ? balanceFlow : null,
    threshold_flow: threshold,
  })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
