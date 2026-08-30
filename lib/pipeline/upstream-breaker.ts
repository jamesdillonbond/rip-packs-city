// lib/pipeline/upstream-breaker.ts
//
// A circuit breaker for a pipeline whose UPSTREAM is down, so it stops paying
// full price per tick to rediscover that.
//
// ── WHY THIS IS NOT THE SATURATION THROTTLE ────────────────────────────────
// `lib/pipeline/saturation.ts` / the `studio-sales-history` self-throttle count
// *other* pipelines' recent failures and skip when the DATABASE looks saturated.
// That is a different instrument with a different failure mode, and reaching for
// it here would repeat a measured mistake: on 2026-08-29 a Top Shot upstream
// outage produced enough global failures that the saturation arm throttled
// pipelines for FOUR OTHER COLLECTIONS that had nothing wrong with them. A
// per-collection outage must never be able to pause an unrelated collection.
//
// So this breaker keys on exactly two things, both local to the caller:
//   1. THIS pipeline's own most recent real run, and
//   2. whether that run's error carries the caller's own upstream SIGNATURE.
//
// ── THE SAFETY PROPERTY, and it is structural rather than a promise ────────
// The breaker can only ever trip when the pipeline's most recent real run was a
// FAILURE matching the signature. A healthy pipeline's most recent run is `ok`,
// so there is no state in which this pauses something that is working. That is
// asserted directly in `__tests__/pipeline-upstream-breaker.test.ts` rather than
// argued here.
//
// ── IT FAILS OPEN, DELIBERATELY, AND THAT IS THE OPPOSITE OF THE THROTTLE ──
// ⚠ The saturation throttle's `count ?? 0` failing OPEN was a real bug, because
// there "open" meant hammering an already-saturated database. Here the stakes
// are inverted: "open" means running one ordinary tick, and "closed" means a
// silently paused pipeline. **One wasted tick is strictly cheaper than a
// pipeline that stops and nobody notices**, so every unreadable state — a query
// error, no rows, a malformed row — returns `skip: false`. Do not "harden" this
// into failing closed without changing that cost argument first.
//
// ── HALF-OPEN BY CONSTRUCTION, so a pause can never be FORGOTTEN ───────────
// There is no counter and no stored breaker state. The window is measured from
// the last failing run, so once it elapses the next tick makes a REAL attempt.
// If the upstream is still down that attempt fails and buys another window; if
// it has recovered the attempt succeeds and the breaker never trips again. A
// manual pause has to be remembered and reversed by a person — this reverses
// itself, which is the whole reason to prefer it.
//
// ⚠ Skip rows are EXCLUDED when finding "the most recent real run". Without
// that, the marker this breaker writes becomes the newest row, the next tick
// sees a non-failure, and the breaker disarms itself after exactly one skip.

import { supabaseAdmin } from "@/lib/supabase"

/** `extra.skipped` value written by a declined tick. Also the marker this module ignores when reading back. */
export const UPSTREAM_OUTAGE_SKIP = "upstream_outage"

/**
 * The Cloudflare "origin is down" shape, which is what a dead Dapper/Top Shot
 * GraphQL host actually returns. Covers all four spellings observed in
 * `pipeline_runs` on 2026-08-30:
 *   "Top Shot GraphQL failed with 530. Response body: ..."
 *   "http 530: error code: 1033"
 *   "graphql: gql HTTP 530: error code: 1033"
 *   "HTTP 530 error code: 1033"
 *
 * ⚠ Deliberately NOT a bare `/530/`: that matches row counts, ids and byte
 * sizes, and a signature that matches ordinary text would let an error in OUR
 * OWN code trip the breaker and then hide itself behind it.
 */
export const CLOUDFLARE_ORIGIN_DOWN =
  /(failed with 530|http\s*530|530\s*error code|error code:\s*1033)/i

export type UpstreamBreakerVerdict = {
  /** True only when the most recent real run failed with the signature inside the window. */
  skip: boolean
  /** Why, for logging. Never null, so a caller cannot record an empty reason. */
  reason:
    | "no_prior_run"
    | "last_run_ok"
    | "error_not_upstream"
    | "outside_window"
    | "upstream_down"
    | "read_failed"
  /** The failing run's error, truncated, when `skip` is true. */
  lastError?: string
  lastFailedAt?: string
}

export type UpstreamBreakerOptions = {
  pipeline: string
  /** How long one failure buys. The next tick after this elapses makes a real attempt. */
  windowMs: number
  signature?: RegExp
  /** Injectable for tests. Defaults to the shared admin client. */
  client?: typeof supabaseAdmin
  now?: () => number
}

/**
 * Decide whether to decline this tick because the pipeline's upstream is down.
 *
 * ⚠ The caller MUST still write a `pipeline_runs` row when it declines. A gate
 * that returns before any write is the fourth cause of `cron_silent` — invoked,
 * deliberately declined, and invisible to every query, so the only way to learn
 * it happened is to read the route.
 */
export async function checkUpstreamBreaker(
  opts: UpstreamBreakerOptions,
): Promise<UpstreamBreakerVerdict> {
  const { pipeline, windowMs, signature = CLOUDFLARE_ORIGIN_DOWN } = opts
  const db = opts.client ?? supabaseAdmin
  const now = opts.now ? opts.now() : Date.now()

  let rows: { ok: boolean | null; error: string | null; finished_at: string | null; extra: unknown }[]
  try {
    // A small window of recent rows, newest first, so skip markers can be
    // stepped over. `id` is the tiebreak: `finished_at` is not unique, and an
    // unordered read of "the latest row" is physical order, not the latest row.
    const { data, error } = await db
      .from("pipeline_runs")
      .select("ok, error, finished_at, extra")
      .eq("pipeline", pipeline)
      .order("finished_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(10)

    // ⚠ supabase-js RETURNS errors rather than throwing, so this branch is the
    // one production actually takes. It is not reachable via the catch below.
    if (error) return { skip: false, reason: "read_failed" }

    // ⚠ SHAPE-CHECK INSIDE THE TRY, and it is not defensive padding — it is a
    // bug this had. `data` was assumed to be an array, so a non-array payload
    // made `.find()` throw from OUTSIDE the try, past this module entirely, and
    // into the CALLING ROUTE's fatal handler. A breaker whose own failure mode
    // is "abort the pipeline it protects" is worse than no breaker.
    // `null` here is UNREADABLE (fail open), which is not the same answer as an
    // empty array (a real pipeline with no history) — so they do not collapse.
    if (data !== null && !Array.isArray(data)) return { skip: false, reason: "read_failed" }
    rows = (data ?? []) as typeof rows
  } catch {
    return { skip: false, reason: "read_failed" }
  }

  const isSkipMarker = (r: (typeof rows)[number]) =>
    !!r.extra &&
    typeof r.extra === "object" &&
    (r.extra as Record<string, unknown>).skipped === UPSTREAM_OUTAGE_SKIP

  const lastReal = rows.find((r) => !isSkipMarker(r))
  if (!lastReal) return { skip: false, reason: "no_prior_run" }
  if (lastReal.ok !== false) return { skip: false, reason: "last_run_ok" }

  const err = lastReal.error ?? ""
  if (!signature.test(err)) return { skip: false, reason: "error_not_upstream" }

  const finishedMs = lastReal.finished_at ? Date.parse(lastReal.finished_at) : NaN
  // An unparseable timestamp is an unreadable state, and unreadable fails OPEN.
  if (!Number.isFinite(finishedMs)) return { skip: false, reason: "read_failed" }
  if (now - finishedMs >= windowMs) return { skip: false, reason: "outside_window" }

  return {
    skip: true,
    reason: "upstream_down",
    lastError: err.slice(0, 200),
    lastFailedAt: lastReal.finished_at ?? undefined,
  }
}
