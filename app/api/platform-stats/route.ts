import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { safeApiError, statusForSafeError } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

// NOTE (2026-08-09): this route has no runtime consumer in app/, components/ or
// lib/ — only its own route test and some docs reference it. It is left in place
// rather than deleted (that is a separate, deliberate call), but its failure was an
// exact copy of the deep-audit D11 trap that was live on /api/collection-stats:
// `{error:"stats_unavailable"}` served with HTTP 200. A caller guarding with the
// idiomatic `if (!res.ok) throw` passes that straight through, stores the error
// object as data, and renders zeros for a failed read. Fixed here so the trap
// is not waiting for whoever wires this route up.
function statsUnavailable(err: unknown) {
  const safe = safeApiError(err, "Platform stats aren't available right now.")
  console.log("[platform-stats] error code=" + safe.code)
  return NextResponse.json(safe, {
    status: statusForSafeError(safe),
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...(safe.retryable ? { "Retry-After": "30" } : {}),
    },
  })
}

export async function GET() {
  try {
    const { data, error } = await boundedRead(
      (supabaseAdmin as any).rpc("get_platform_stats"),
      "api/platform-stats/get_platform_stats",
    )

    if (error) {
      return statsUnavailable(error)
    }

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "s-maxage=300, stale-while-revalidate=60",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (err) {
    return statsUnavailable(err)
  }
}
