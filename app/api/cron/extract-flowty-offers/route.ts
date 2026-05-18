// app/api/cron/extract-flowty-offers/route.ts
//
// Drains firestore:STOREFRONT_OFFER_CREATED + STOREFRONT_OFFER_CANCELLED
// events from flowty_archive.api_harvest_20260512 into the new
// public.marketplace_offers partitioned table.
//
// Schedule cron-job.org hourly at :39 with batch_size=5000. With
// 7,907 CREATED + 4,594 CANCELLED rows in the source on 2026-05-17,
// the backlog drains in ~3 hours.
//
// Auth: Bearer INGEST_SECRET_TOKEN (or ?token=). GET/POST.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "extract-flowty-offers"

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

async function emitHeartbeat(): Promise<void> {
  try {
    await (supabaseAdmin as any).rpc("upsert_cron_heartbeat", {
      p_pipeline: PIPELINE_NAME,
      p_source: "vercel_route",
    })
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] heartbeat err: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  await emitHeartbeat()

  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  // Accept batch_size from EITHER the JSON body (cron-job.org convention)
  // or the query string. Same fix as extract-flowty-purchases — see that
  // route for the audit context. cron-job.org sends {"p_batch_size": 150}
  // in the body; without this branch the route fell back to the default
  // 5000 and timed out at 30s every tick.
  let bodyBatchSize: number | undefined
  try {
    const ct = req.headers.get("content-type") ?? ""
    if (ct.includes("application/json")) {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null
      if (body && typeof body === "object") {
        const raw = body.p_batch_size ?? body.batch_size
        const parsed = Number(raw)
        if (Number.isFinite(parsed)) bodyBatchSize = parsed
      }
    }
  } catch {
    // body parse failed (empty body, malformed JSON, etc.) — fall through
    // to query param + default.
  }
  const requestedBatch = bodyBatchSize ?? Number(req.nextUrl.searchParams.get("batch_size") ?? 5000)
  const batchSize = Math.max(100, Math.min(20000, requestedBatch || 5000))

  let ok = true
  let errMsg: string | null = null
  let result: any = null

  try {
    const { data, error } = await (supabaseAdmin as any).rpc(
      "extract_flowty_offers",
      { p_batch_size: batchSize }
    )
    if (error) {
      ok = false
      errMsg = error.message
    } else {
      result = data
    }
  } catch (e) {
    ok = false
    errMsg = e instanceof Error ? e.message : String(e)
  }

  const events = Number(result?.events_processed ?? 0)
  const inserted = Number(result?.inserted_offers ?? 0)
  const skippedUnmapped = Number(result?.skipped_unmapped_collection ?? 0)

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: events,
      p_rows_written: inserted,
      p_rows_skipped: skippedUnmapped,
      p_ok: ok,
      p_error: errMsg,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        batch_size: batchSize,
        harvest_rows_processed: result?.harvest_rows_processed,
        events_processed: events,
        inserted_offers: inserted,
        skipped_unmapped_collection: skippedUnmapped,
        duration_ms: Date.now() - startedMs,
      },
    })
  } catch (e) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  return NextResponse.json({ ok, error: errMsg, ...result })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
