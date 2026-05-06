// app/api/cron/sync-nba-odds/route.ts
//
// Cron entrypoint that fans out to the sync-nba-odds Supabase edge
// function. Schedule on cron-job.org every 60 minutes during 22:00 UTC →
// 06:00 UTC (covers 4pm – 2am ET, the NBA active window). Bearer
// INGEST_SECRET_TOKEN / CRON_SECRET. The route returns 202 immediately;
// the edge function's EdgeRuntime.waitUntil owns the actual work.

import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 25

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const INGEST_SECRET_TOKEN = process.env.INGEST_SECRET_TOKEN!

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? ""
  const queryToken = req.nextUrl.searchParams.get("token")
  const cronSecret = process.env.CRON_SECRET
  const isValid =
    authHeader === `Bearer ${INGEST_SECRET_TOKEN}` ||
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    queryToken === INGEST_SECRET_TOKEN
  if (!isValid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-nba-odds`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${INGEST_SECRET_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    let body: unknown = null
    try { body = JSON.parse(text) } catch { /* leave null */ }
    return NextResponse.json(
      { accepted: res.ok, edge_status: res.status, edge_body: body ?? text.slice(0, 500) },
      { status: res.ok ? 202 : 502 },
    )
  } catch (err) {
    return NextResponse.json(
      { error: "edge_invoke_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}

export async function POST(req: NextRequest) {
  return GET(req)
}
