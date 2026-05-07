// app/api/cron/ingest-external-announcements/route.ts
//
// Retired 2026-05-07. The RSS / Nitter ingest path was replaced by the
// webhook ingest at /api/admin/announcements (see commit 92aa5e8). This
// route remains in the tree only so cron-job.org schedules still pointed
// at it get a structured 410 Gone instead of triggering edge invocations
// or showing up as pipeline failures. Delete the cron-job.org schedule
// and then this file together once both have aged out.

import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 5

const INGEST_SECRET_TOKEN = process.env.INGEST_SECRET_TOKEN!

const RETIRED_BODY = {
  error: "gone",
  retired_at: "2026-05-07",
  reason: "RSS announcement ingest retired in favor of webhook ingest",
  replacement: "/api/admin/announcements",
} as const

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
  return NextResponse.json(RETIRED_BODY, { status: 410 })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
