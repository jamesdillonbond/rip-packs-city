// Publishable failure response for the public /insights board APIs.
//
// WHY THIS EXISTS. All six single-view board routes (squeeze, trophies,
// offer-spread, pinnacle-scarcity, allday-scarcity, set-squeeze) ended their
// error path with the same line:
//
//     return NextResponse.json({ error: error.message }, { status: 500 });
//
// These are ANON-PUBLIC routes, so under disk-IO saturation that handed every
// visitor Postgres's own text — "canceling statement due to statement timeout" —
// and the concierge re-published it verbatim too (fetchPublicInsight forwards
// `json.error` straight into the model's tool result). Same defect the deep-audit
// D3 finding fixed on /api/sets; lib/api-error.ts is the remedy, and these routes
// were simply never migrated onto it.
//
// The rule from lib/api-error.ts: classify server-side, LOG the detail, return a
// stable code plus copy a human can act on. Never pass a driver message through.
//
// Two things this adds on top of a bare safeApiError() call, both load-bearing:
//
//  1. `Cache-Control: no-store`. Every one of these routes sets a PUBLIC edge
//     cache on its success response (`s-maxage=300`..`3600`). Without an explicit
//     no-store on the failure, a transient 503 risks being held at the CDN and
//     served to everyone for the rest of the TTL — pinning a momentary blip into
//     a sustained outage.
//  2. `Retry-After` when the classification says retrying is reasonable, so the
//     status is actionable rather than just honest.
//
// Status comes from statusForSafeError: a statement timeout is 503 (transient
// capacity, and it keeps these routes out of the hard-5xx budget that pages on
// genuine breakage), anything unrecognized stays 500.

import { NextResponse } from "next/server"
import { safeApiError, statusForSafeError } from "@/lib/api-error"

// Callers hand us three different error shapes across this surface:
//   - a PostgrestError object            (`.from(...)` / `.rpc(...)`)
//   - a thrown Error                     (catch blocks)
//   - a bare STRING                      (lib/supabase-paginate returns `error: string`)
// safeApiError's message reader only understands the first two, so a bare string
// would silently fall through to "internal" and a statement timeout would be
// reported as a 500 instead of a retryable 503. Normalize before classifying.
function normalize(err: unknown): unknown {
  return typeof err === "string" ? { message: err } : err
}

/** Detail for the SERVER LOG only — never merged into the response body. */
function errDetail(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown }
    const code = typeof e.code === "string" ? e.code : ""
    const message = typeof e.message === "string" ? e.message : ""
    return `${code}${code && message ? " " : ""}${message}`.trim() || String(err)
  }
  return String(err)
}

/**
 * Build the publishable failure response for a board route.
 *
 * @param err   the PostgrestError (or thrown value) — logged, never published
 * @param board the route's path BELOW /api/public/, used verbatim as the log
 *              scope — e.g. "insights/squeeze", "special-serial-owners". It is
 *              the full segment rather than a bare slug so this helper can serve
 *              every anon-public read surface without emitting a log prefix that
 *              names the wrong directory.
 * @param fallback human copy for an unclassified failure
 */
export function boardUnavailable(
  err: unknown,
  board: string,
  fallback = "This board isn't available right now."
): NextResponse {
  const safe = safeApiError(normalize(err), fallback)
  // Detail goes to the log so the failure is still diagnosable in Vercel.
  console.error(`[public/${board}] code=${safe.code} detail=${errDetail(err)}`)
  return NextResponse.json(safe, {
    status: statusForSafeError(safe),
    headers: {
      // See (1) above — must not be edge-cached alongside the s-maxage success.
      "Cache-Control": "no-store",
      ...(safe.retryable ? { "Retry-After": "30" } : {}),
    },
  })
}
