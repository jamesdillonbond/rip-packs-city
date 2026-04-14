import { NextRequest, NextResponse, after } from "next/server"

// ── UFC Strike pipeline trigger ──────────────────────────────────────────────
// Chains: ufc-listing-cache → ufc-sales-indexer. Pointed at by cron-job.org.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || token !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const origin = new URL(req.url).origin

  after(async () => {
    try {
      const cacheRes = await fetch(`${origin}/api/ufc-listing-cache?token=${TOKEN}`, {
        method: "GET",
        signal: AbortSignal.timeout(55000),
      })
      console.log(`[ufc-pipeline] listing-cache status=${cacheRes.status}`)
    } catch (err) {
      console.error("[ufc-pipeline] listing-cache failed:", err instanceof Error ? err.message : String(err))
    }

    try {
      const salesRes = await fetch(`${origin}/api/ufc-sales-indexer?token=${TOKEN}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(55000),
      })
      console.log(`[ufc-pipeline] sales-indexer status=${salesRes.status}`)
    } catch (err) {
      console.error("[ufc-pipeline] sales-indexer failed:", err instanceof Error ? err.message : String(err))
    }
  })

  return NextResponse.json({
    ok: true,
    message: "UFC pipeline triggered",
    triggeredAt: new Date().toISOString(),
  })
}
