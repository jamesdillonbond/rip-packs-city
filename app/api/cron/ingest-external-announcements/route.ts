// app/api/cron/ingest-external-announcements/route.ts
//
// Cron entrypoint for external announcement ingestion (Top Shot /
// Pinnacle / AllDay RSS feeds). Schedule on cron-job.org every 30
// minutes once the upstream Nitter URLs are stable; while they remain
// flaky, schedule defensively every 60 min and surface failures
// through pipeline_runs.

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
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ingest-external-announcements`, {
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
