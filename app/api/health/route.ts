import { NextResponse } from "next/server"

// Lightweight liveness check. MUST NOT have heavy dependencies.
// Vercel/monitoring/cron uses this to verify the runtime is alive;
// a heavy query here turns the health endpoint into a failure correlator
// rather than an availability signal.
//
// For DB/pipeline freshness see /api/ready — the readiness probe that
// returns the per-collection sales slice. It no longer calls health_check() —
// that function is service_role only and must stay that way (deep-audit R44).
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  )
}
