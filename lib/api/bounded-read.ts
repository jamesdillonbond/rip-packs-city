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
  /**
   * Present on a `{ count: "exact", head: true }` read.
   *
   * 🚨 **NULL ON TIMEOUT, NEVER 0**, and this is the one field where the bound
   * could itself become the defect it exists to prevent. CLAUDE.md names `?? 0`
   * on a supabase count as one of the two fabricated-number shapes: a failed
   * count that resolves to zero publishes a MEASURED zero. A bound that filled
   * in `count: 0` on overrun would manufacture that at every call site at once,
   * which is strictly worse than the 504 it replaced.
   */
  count?: number | null
}

/**
 * The default budget for a database read a human is waiting on.
 *
 * ⚠ Overridable ONLY through `API_DB_READ_TIMEOUT_MS`, and that exists so a
 * test can prove a hanging read resolves without waiting eight real seconds.
 * A non-numeric or non-positive value falls back to the default rather than
 * disabling the bound — an env typo must not silently un-bound production.
 */
/**
 * The `code` this helper stamps on a timeout, so `safeApiError` can classify it
 * as transient (503 + `Retry-After`) rather than as a hard internal 500.
 *
 * ⚠ Exported so the classifier imports the STRING rather than re-typing it —
 * a typo on either side fails OPEN, silently restoring the non-retryable 500
 * this constant exists to prevent, with nothing red to show for it.
 */
export const RPC_READ_TIMEOUT_CODE = "RPC_READ_TIMEOUT"

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
          // `count: null` explicitly, not omitted: a caller doing `count ?? 0`
          // gets the same answer either way, but stating it keeps the contract
          // readable at the one place someone might be tempted to put a 0.
          //
          // 🚨 `code` IS LOAD-BEARING AND IT WAS MISSING UNTIL 2026-09-04.
          // `safeApiError` classifies on `error.code` (or on specific message
          // substrings like "statement timeout"). This timeout carried NEITHER —
          // its message is "read exceeded 8000ms" — so it fell through to the
          // generic branch and every one of the **86 routes** that pair this
          // helper with `apiErrorResponse` answered a timeout as
          // `{ code: "internal", retryable: false }` with status **500** and no
          // `Retry-After`.
          //
          // ⛔ That is the precise OPPOSITE of why the bound exists. The point is
          // to turn a hang into an honest, ACTIONABLE answer; instead it told the
          // caller the failure was permanent and not worth retrying, when a
          // retry is exactly what works. Observed live on
          // `/api/collection-stats`: 500 at 8.2 s, then **200 at 4.0 s on the
          // very next request**.
          //
          // ⚠ Deliberately NOT `57014` and NOT the words "statement timeout",
          // either of which would have classified correctly by accident. Both
          // would be FALSE: Postgres cancelled nothing. We abandoned the WAIT and
          // the query is still running — the helper's own header says so. This is
          // OUR read timeout and it gets its own honest name.
          () =>
            resolve({
              data: null,
              error: {
                code: RPC_READ_TIMEOUT_CODE,
                message: `[${label}] read exceeded ${timeoutMs}ms`,
              },
              count: null,
            }),
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
      return { data: null, error: e as any, count: null }
    }
    return { data: null, error: { message: String(e) }, count: null }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
