// app/api/cron/trigger-backfill/route.ts
// GET or POST — one-time endpoint to trigger FMV backfill manually
// Requires INGEST_SECRET_TOKEN for auth

import { NextRequest, NextResponse } from "next/server"
import { bearerMatches, tokenMatches } from "@/lib/auth/bearer-secret"

function siteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://www.rippackscity.com")
  )
}

async function handleTrigger(req: NextRequest) {
  // Check auth token from query param or header
  // constant-time compares via the shared helpers (CISO 2026-11-04); same three carriers as before
  const ingestToken = process.env.INGEST_SECRET_TOKEN
  const authorized =
    !!ingestToken &&
    (tokenMatches(req.nextUrl.searchParams.get("token"), "INGEST_SECRET_TOKEN") ||
      tokenMatches(req.headers.get("x-ingest-token"), "INGEST_SECRET_TOKEN") ||
      bearerMatches(req.headers.get("authorization"), "INGEST_SECRET_TOKEN"))

  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const base = siteUrl()

  try {
    const res = await fetch(`${base}/api/fmv-recalc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ingest-token": ingestToken as string,
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
