import { NextRequest, NextResponse } from "next/server"

// ── AllDay ingest (deprecated) ───────────────────────────────────────────────
//
// Flowty's collection POST endpoint now returns empty nfts arrays for every
// page (confirmed broken April 2026), and the AllDay GQL was never reliable.
// The on-chain event indexer at /api/allday-sales-indexer replaces this route
// for sales ingestion. This handler is kept as a no-op so existing pipeline
// chains and cron jobs keep succeeding.
// ─────────────────────────────────────────────────────────────────────────────

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function checkAuth(req: NextRequest): boolean {
  const token = process.env.INGEST_SECRET_TOKEN ?? ""
  if (!token) return false
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  return bearer === token || urlToken === token
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return unauthorized()
  return NextResponse.json({
    ok: true,
    skipped: "flowty_api_empty",
    note: "See /api/allday-sales-indexer for on-chain sales ingestion.",
  })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
