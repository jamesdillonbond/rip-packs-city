import { NextRequest, NextResponse, after } from "next/server"

// ── UFC Strike pipeline trigger ──────────────────────────────────────────────
// Chains: ufc-listing-cache → ufc-sales-indexer. Pointed at by cron-job.org.
//
// 🚨 THE TOKEN IS SENT AS A HEADER, NEVER IN THE URL, AND THAT IS THE POINT.
// Both downstream routes accept EITHER `Authorization: Bearer <INGEST_SECRET_TOKEN>`
// or `?token=<INGEST_SECRET_TOKEN>` (see their `bearer !== TOKEN && urlToken !== TOKEN`
// checks). This route used to use the QUERY-STRING form, which writes a secret
// shared across ~15 functions into request logs on every call. The header form is
// equivalent to the callee and is not logged.
// ⛔ Do NOT "confirm" the old leak by reading the request logs — reading them IS
// the leak. The caller's source is the proof, and it is these two fetches.
// ⚠ Same class as the `sales-serial-backfill` trigger fix; the token should still
// be treated as EXPOSED. Stopping new writes does not un-write the old ones.
// ⓘ Safe in this direction only: the callees still ACCEPT `?token=`, so dropping
// it here cannot 401. Deleting the callees' `?token=` branch is a separate step
// and must come AFTER this, never before.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

function authorized(req: NextRequest): boolean {
  if (!TOKEN) return false
  const auth = req.headers.get("authorization") ?? ""
  if (auth.startsWith("Bearer ") && auth.slice(7) === TOKEN) return true
  const qp = req.nextUrl.searchParams.get("token") ?? ""
  return qp === TOKEN
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const origin = new URL(req.url).origin

  after(async () => {
    try {
      const cacheRes = await fetch(`${origin}/api/ufc-listing-cache`, {
        method: "GET",
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(55000),
      })
      console.log(`[ufc-pipeline] listing-cache status=${cacheRes.status}`)
    } catch (err) {
      console.error("[ufc-pipeline] listing-cache failed:", err instanceof Error ? err.message : String(err))
    }

    try {
      const salesRes = await fetch(`${origin}/api/ufc-sales-indexer`, {
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
