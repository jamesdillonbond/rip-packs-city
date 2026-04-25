// app/api/flowty-monitor/status/route.ts
//
// GET /api/flowty-monitor/status — Authorization: Bearer $INGEST_SECRET_TOKEN
//
// Single read-only JSON endpoint that wraps the flowty_* dashboard views into
// one response, so we can sanity-check the failed-tx scanner without writing
// SQL each time. Backs the operational dashboard and the eventual external
// pitch artifact.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

export const dynamic = "force-dynamic"

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function GET(req: NextRequest) {
  if (!TOKEN || req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return unauthorized()
  }

  const t0 = Date.now()
  const [
    healthRes,
    dailyRes,
    failureSummaryRes,
    topWalletsRes,
    storageCohortRes,
  ] = await Promise.all([
    supabaseAdmin.from("flowty_scanner_health").select("*").maybeSingle(),
    supabaseAdmin
      .from("flowty_daily_summary")
      .select("*")
      .order("day", { ascending: false })
      .limit(30),
    supabaseAdmin
      .from("flowty_failure_summary")
      .select("*")
      .limit(50),
    supabaseAdmin
      .from("flowty_top_failing_wallets")
      .select("*")
      .limit(25),
    supabaseAdmin
      .from("flowty_storage_cap_cohort")
      .select("*")
      .limit(25),
  ])

  const errors: string[] = []
  for (const [name, r] of [
    ["scanner_health", healthRes],
    ["daily_summary", dailyRes],
    ["failure_summary", failureSummaryRes],
    ["top_failing_wallets", topWalletsRes],
    ["storage_cap_cohort", storageCohortRes],
  ] as const) {
    if (r.error) errors.push(`${name}: ${r.error.message}`)
  }

  return NextResponse.json({
    fetched_at: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
    errors: errors.length ? errors : undefined,
    scanner_health: healthRes.data ?? null,
    daily_summary: dailyRes.data ?? [],
    failure_summary: failureSummaryRes.data ?? [],
    top_failing_wallets: topWalletsRes.data ?? [],
    storage_cap_cohort: storageCohortRes.data ?? [],
  })
}
