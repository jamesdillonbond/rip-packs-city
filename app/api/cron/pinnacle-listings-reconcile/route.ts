// app/api/cron/pinnacle-listings-reconcile/route.ts
//
// Phase 2C of the chain-event Pinnacle listings pipeline. Calls the
// pinnacle_listings_reconcile() SECDEF RPC (applied via MCP migration
// pinnacle_listings_reconcile_phase_2c on 2026-05-11 20:13 UTC) which
// re-projects pinnacle_listing_events into pinnacle_editions.ask_price
// with ask_source='pinnacle_direct'. Replaces the upstream Flowty
// $1-uniform floor signal for Pinnacle.
//
// The RPC is idempotent and fast (~ms), so this route runs synchronously
// and returns the JSONB result directly rather than fire-and-forget.
//
// Bearer auth: INGEST_SECRET_TOKEN (or ?token= query for browser cron).
// Schedule (manual, cron-job.org): 9,24,39,54 * * * * — offset clear of
// pinnacle-events-ingest at 4,19,34,49 so reconcile runs ~5min after
// fresh event-ingest data lands.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PIPELINE = "pinnacle-listings-reconcile"

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

async function handle(req: NextRequest) {
  const expected = process.env.INGEST_SECRET_TOKEN
  if (!expected) return NextResponse.json({ error: "INGEST_SECRET_TOKEN not set" }, { status: 500 })
  const auth = req.headers.get("authorization") ?? ""
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (auth !== `Bearer ${expected}` && urlToken !== expected) return unauthorized()

  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  let ok = true
  let errorMsg: string | null = null
  const extra: Record<string, unknown> = {}
  let rowsWritten = 0
  let result: Record<string, unknown> | null = null

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("pinnacle_listings_reconcile")
    if (error) throw new Error(error.message)
    result = (data ?? null) as Record<string, unknown> | null
    if (result) {
      const updated = Number(result.editions_updated ?? 0)
      rowsWritten = updated
      extra.editions_updated = updated
      extra.editions_first_time_priced = Number(result.editions_first_time_priced ?? 0)
      extra.editions_with_lower_floor = Number(result.editions_with_lower_floor ?? 0)
      extra.editions_with_higher_floor = Number(result.editions_with_higher_floor ?? 0)
      extra.algo_version = result.algo_version ?? null
      if (Array.isArray(result.sample_changes)) {
        extra.sample_changes = (result.sample_changes as unknown[]).slice(0, 5)
      }
    }
  } catch (err) {
    ok = false
    errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`[${PIPELINE}] fatal: ${errorMsg}`)
  }

  extra.elapsed_ms = Date.now() - startedMs

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: startedAtIso,
      p_rows_found: rowsWritten,
      p_rows_written: rowsWritten,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errorMsg,
      p_collection_slug: "disney_pinnacle",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: Object.keys(extra).length > 0 ? extra : null,
    })
  } catch (logErr) {
    console.log(`[${PIPELINE}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`)
  }

  return NextResponse.json({
    ok,
    message: ok ? "reconcile complete" : "reconcile failed",
    error: errorMsg,
    result,
    elapsed_ms: extra.elapsed_ms,
  }, { status: ok ? 200 : 500 })
}

export async function POST(req: NextRequest) {
  return handle(req)
}

export async function GET(req: NextRequest) {
  return handle(req)
}
