import { NextResponse } from "next/server"

// Lightweight liveness check. MUST NOT have heavy dependencies.
// Vercel/monitoring/cron uses this to verify the runtime is alive;
// a heavy query here turns the health endpoint into a failure correlator
// rather than an availability signal.
//
// For DB/pipeline freshness see /api/ready — the readiness probe that
// runs the Supabase health_check RPC and returns per-collection telemetry.
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
