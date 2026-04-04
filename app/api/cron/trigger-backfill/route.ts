// app/api/cron/trigger-backfill/route.ts
// GET or POST — one-time endpoint to trigger FMV backfill manually
// Requires INGEST_SECRET_TOKEN for auth

import { NextRequest, NextResponse } from "next/server"

function siteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://rip-packs-city.vercel.app")
  )
}

async function handleTrigger(req: NextRequest) {
  // Check auth token from query param or header
  const token =
    req.nextUrl.searchParams.get("token") ??
    req.headers.get("x-ingest-token") ??
    req.headers.get("authorization")?.replace("Bearer ", "")

  if (!process.env.INGEST_SECRET_TOKEN || token !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const base = siteUrl()

  try {
    const res = await fetch(`${base}/api/fmv-recalc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ingest-token": process.env.INGEST_SECRET_TOKEN,
      },
      body: JSON.stringify({ backfill: true }),
      signal: AbortSignal.timeout(120000),
    })

    const data = await res.json()

    return NextResponse.json({
      success: res.ok,
      status: res.status,
      result: data,
      triggeredAt: new Date().toISOString(),
    })
  } catch (err: any) {
    return NextResponse.json({
      success: false,
      error: err.message,
      triggeredAt: new Date().toISOString(),
    }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handleTrigger(req)
}

export async function POST(req: NextRequest) {
  return handleTrigger(req)
}
