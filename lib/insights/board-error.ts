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
import { apiErrorResponse } from "@/lib/api-error"

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
  // The mechanics (normalize a bare-string error, classify, log the detail,
  // no-store + Retry-After) now live in lib/api-error.ts so every anon-reachable
  // route shares ONE implementation. This wrapper keeps the board-specific log
  // scope and default copy, and keeps the three-layer helper map in CLAUDE.md
  // intact — it is a thin alias, not a fourth peer helper.
  return apiErrorResponse(err, `public/${board}`, fallback)
}
