// lib/api/bounded-read.ts
//
// Bound a DATABASE read inside an API route, RESOLVING into the route's own
// `if (error)` branch when it overruns.
//
// ── THE GAP THIS FILLS, MEASURED 2026-09-03 RATHER THAN ASSUMED ────────────
// `__tests__/api-routes-that-degrade-honestly-also-bound-their-reads.test.ts`
// froze this population at **131 routes that call `apiErrorResponse()` — so
// they have already decided they owe the caller an honest answer on a failed
// read — of which 130 bound nothing at all.** A read that is merely SLOW errors
// nowhere, so none of those routes can REACH the branch it already has: the
// platform kills the function first and the caller gets a 504 in place of the
// degraded answer sitting three lines below.
//
// The same class was fixed for server PAGES by `withBoardBudget` (a ban at zero
// that holds over 183 files) and for the pack-detail page by
// `lib/pack-dist/fetchers.ts`. API routes had no instrument at all until that
// ratchet, and no shared helper until this file.
//
// ── WHY IT RESOLVES AND `withBoardBudget` REJECTS ──────────────────────────
// `withBoardBudget` rejects, which is right for a server page: every one of
// those has a try/catch that sets `ok:false`. An API route does not. The shape
// in this tree is
//
//     const { data, error } = await supabase.rpc(…)
//     if (error) return apiErrorResponse(error, "api/…")
//
// with NO try/catch around the read — `app/api/profile/hero-moment` and
// `app/api/wallet-summary` are both exactly this. Handing those a rejection
// would escape the handler and turn a slow read into an unhandled 500, which is
// a WORSE answer than the 504 it replaced: it is a failure the route's own
// honest-error helper never gets to classify. Matching the `{ data, error }`
// contract routes an overrun into the branch that is already there, so
// converting a route is a one-line wrap that cannot introduce a second,
// divergent failure policy.
//
// ⚠ It is the same envelope `app/api/sniper-feed/route.ts` proved on 2026-09-03
// against five reads that never settle. That one stays local to its route: it
// carries a route-specific env override and a 45 s wall this default is not
// sized for, and re-pointing a route that shipped yesterday buys nothing.
//
// ⚠ THE ABANDONED QUERY KEEPS RUNNING. supabase-js has no cancel, so we stop
// WAITING on the read; we do not stop it. That is the intended trade and it is
// the same one `withBoardBudget` documents — the caller gets an honest 503
// instead of blocking on a throttled database.
//
// ⛔ IT DOES NOT PRESCRIBE A VALUE, and the default is not a claim about any
// particular query. 8 s is the same budget `BOARD_LIVE_TIMEOUT_MS` uses for a
// read a human is waiting on, and it sits well under both the Postgres 30 s
// `statement_timeout` and every route `maxDuration` in this tree — so an
// overrun here is reported by US, in our own words, rather than surfacing as a
// `57014` the caller cannot act on. A drain or a backfill wants a much larger
// number and should pass one.

/**
 * The envelope every supabase-js read resolves to, and the one this helper
 * guarantees on every path.
 *
 * ⚠ `data`/`error` are `any` DELIBERATELY, and it is a widening of nothing:
 * every call site in this tree already destructures a service-role client that
 * CLAUDE.md records as "typed `any` in API routes", and `apiErrorResponse`
 * takes `unknown`. A generic here inferred `unknown` off supabase-js's
 * `PromiseLike` and broke `data?.x` at twelve call sites — buying no safety the
 * routes did not already lack, at the price of a cast on each one.
 */
export interface BoundedReadResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: any
}

/**
 * The default budget for a database read a human is waiting on.
 *
 * ⚠ Overridable ONLY through `API_DB_READ_TIMEOUT_MS`, and that exists so a
 * test can prove a hanging read resolves without waiting eight real seconds.
 * A non-numeric or non-positive value falls back to the default rather than
 * disabling the bound — an env typo must not silently un-bound production.
 */
export const API_DB_READ_TIMEOUT_MS = 8_000

export function apiReadTimeoutMs(): number {
  const raw = Number(process.env.API_DB_READ_TIMEOUT_MS ?? "")
  return Number.isFinite(raw) && raw > 0 ? raw : API_DB_READ_TIMEOUT_MS
}

/**
 * Wrap a supabase-js read so it cannot outlive `timeoutMs`.
 *
 * @param p        The supabase-js builder or promise. Thenable is enough.
 * @param label    Namespaced into the error message, e.g.
 *                 `"profile/hero-moment"`. It is what an operator greps and
 *                 what `apiErrorResponse` classifies, so name the ROUTE and the
 *                 READ, not just the route.
 * @param timeoutMs Budget for this read. Defaults to `apiReadTimeoutMs()`.
 *
 * Never throws. A transport-level rejection is folded into the same envelope,
 * because the call sites destructure `{ data, error }` and have no catch —
 * supabase-js RETURNS Postgrest errors, but the transport underneath it can
 * still reject, and a route that handles one and not the other is only half
 * converted.
 *
 * 🚨 THE THROWN VALUE IS PASSED THROUGH INTACT, NOT REDUCED TO ITS MESSAGE, and
 * the first draft of this helper got that wrong in a way that DOWNGRADED an
 * honest answer. `apiErrorResponse` classifies on `error.code` — a `57014`
 * statement timeout becomes a retryable **503**, everything else a hard 500 —
 * so rebuilding the error as `{ message }` silently stripped the one field the
 * classification reads, and `/api/collection-snapshot` started answering a
 * statement timeout with a 500 that told the caller not to retry. Caught by
 * `__tests__/api-collection-snapshot.test.ts`, which had pinned the 503 months
 * earlier. **Preserve the thrown object whenever it can carry a code.**
 */
export async function boundedRead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p: PromiseLike<any>,
  label: string,
  timeoutMs: number = apiReadTimeoutMs(),
): Promise<BoundedReadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race<BoundedReadResult>([
      Promise.resolve(p),
      new Promise<BoundedReadResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ data: null, error: { message: `[${label}] read exceeded ${timeoutMs}ms` } }),
          timeoutMs,
        )
      }),
    ])
  } catch (e) {
    // An object carrying a `message` is handed back UNCHANGED, so `code`,
    // `details` and `hint` survive for `apiErrorResponse` to classify — this is
    // exactly what the route's own `catch` used to receive. Only a thrown
    // primitive (a bare string, a number) needs an envelope built for it, and
    // that one cannot have carried a code to begin with.
    if (e !== null && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { data: null, error: e as any }
    }
    return { data: null, error: { message: String(e) } }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
