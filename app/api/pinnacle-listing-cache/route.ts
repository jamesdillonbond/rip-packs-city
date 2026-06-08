// app/api/pinnacle-listing-cache/route.ts
//
// RETIRED 2026-06-08 (Flowty teardown). This route fetched Pinnacle listings
// from Flowty (api2.flowty.io), wrote them into pinnacle_cached_listings, then
// projected the cheapest ask per legacy edition_key into pinnacle_editions
// .ask_price via pinnacle_refresh_editions_ask().
//
// Flowty shut down its marketplace 2026-05-13 and now serves a frozen
// 2026-05-27 snapshot (~141 rows, mostly the uniform $1 floor). Re-running this
// every 20 min kept re-stamping pinnacle_editions.ask_price + ask_updated_at
// from that stale snapshot, masking the genuinely-fresh on-chain ASK that
// pinnacle-listings-reconcile writes (ask_source='pinnacle_direct', from
// pinnacle_listing_events) and inventing fake "deals" wherever the concierge
// read pinnacle_cached_listings.
//
// The live, correct Pinnacle floor/ASK sources are now:
//   • pinnacle_catalog.floor_ask     — per-render, daily from the studio GraphQL
//                                       (backfill-pinnacle-catalog)
//   • pinnacle_editions.ask_price     — on-chain, every ~15 min via
//     (ask_source='pinnacle_direct')   pinnacle-listings-reconcile
//
// This route is left as an inert, auth-gated no-op so the cron-job.org entry
// (every ~20 min) keeps reporting a healthy pipeline_runs row instead of
// flipping to "stalled" while the operator removes the schedule. Nothing here
// touches Flowty, pinnacle_cached_listings, or pinnacle_refresh_editions_ask.
// To fully retire: delete the cron-job.org entry, then delete this file.

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const PIPELINE_NAME = "pinnacle-listing-cache"
const COLLECTION_SLUG = "disney_pinnacle"

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

async function run(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  const expected = process.env.INGEST_SECRET_TOKEN
  if (auth !== `Bearer ${expected}` && urlToken !== expected) return unauthorized()

  const startedAtIso = new Date().toISOString()

  // Inert: log a healthy run so cadence monitoring stays green, then return.
  try {
    await supabase.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: 0,
      p_rows_written: 0,
      p_rows_skipped: 0,
      p_ok: true,
      p_error: null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        retired: true,
        note: "Flowty teardown — ASK now sourced on-chain via pinnacle-listings-reconcile; floor via pinnacle_catalog",
      },
    })
  } catch (e: any) {
    console.log(`[pinnacle-listing-cache] log_pipeline_run err: ${e?.message ?? "unknown"}`)
  }

  return NextResponse.json({ ok: true, retired: true, message: "pinnacle-listing-cache is retired (Flowty teardown)" })
}

export async function GET(req: NextRequest) { return run(req) }
export async function POST(req: NextRequest) { return run(req) }
