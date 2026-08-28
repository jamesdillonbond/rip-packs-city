// Small wrapper around Supabase RPC calls that retries connection-class
// errors with exponential backoff. Used by every /api/analytics/* route.
//
// Why: when Vercel cold-starts a batch of analytics functions in parallel
// (e.g. a fresh deploy + a user opening /analytics/loans/topshot which
// fans out to 7 RPCs), a few of them race against Supabase's pgbouncer
// connection limit and surface as 500s. The errors self-heal within
// seconds; we just need to retry rather than failing the whole route.
//
// Logic-class errors (42xxx — undefined function, syntax errors, etc.)
// are *never* retried — they will fail every attempt and burning the
// retry budget just delays the user-visible failure.
//
// Neither is 57014 (query_canceled / "canceling statement due to statement
// timeout"). ADDED 2026-07-26: the message test below matches the substring
// "timeout", and Postgres' 57014 message *contains* it, so every statement
// timeout was being retried 3x. A statement that exceeded its timeout will
// exceed it again on attempt 2 and 3 — the retry is pure amplification, and
// it was tripling load on the product's highest-traffic surface
// (/[collection]/edition/[slug], 51.4% of collection page views, 272 such
// timeouts in 24h). 53300 and 57P01 remain transient: those are pool
// problems, not statement problems.

import type { SupabaseClient, PostgrestError } from "@supabase/supabase-js"

// Postgres SQLSTATE codes we treat as transient connection problems.
// 08006 — connection failure
// 08001 — sqlclient unable to establish sqlconnection
// 08000 — connection exception
// 53300 — too many connections
// 57P01 — admin shutdown / pgbouncer pool exhaustion
const TRANSIENT_CODES = new Set(["08006", "08001", "08000", "53300", "57P01"])

// SQLSTATEs that look transient by message but are not. Checked before the
// message heuristics below, which are deliberately broad.
// 57014 — query_canceled ("canceling statement due to statement timeout")
const NEVER_RETRY_CODES = new Set(["57014"])

// ── The wall-clock bound (2026-08-13) ──────────────────────────────────────
// Retrying handles an RPC that FAILS. Nothing here handled an RPC that never
// answers at all — and those are not the same event. supabase-js issues a plain
// `fetch` with no signal, so a stuck connection-acquire inside Supavisor parks
// the await indefinitely (undici's own default ceiling is ~300s). The retry
// loop never runs, because there is no error to retry.
//
// That is how /[collection]/edition/[slug] hung on "SCANNING THE MARKETPLACE…".
// These five entity routes ship a loading.tsx, so Next flushes the shell and a
// 200 immediately and streams the page after — a render that never finishes
// leaves the skeleton on screen with no error, no failing status and no client
// XHR to inspect, until Vercel kills the function. Production bears this out:
// the largest error group on the project is "Task timed out after 300 seconds",
// and /[collection]/edition/[slug] is one of the routes listed in it.
//
// Same lesson the public boards learned on 2026-08-12 (BOARD_LIVE_TIMEOUT_MS):
// SLOW and BROKEN are equally unservable, and only broken was modelled.
//
// ── Why 45s, and why it must not be tighter ────────────────────────────────
// This bound exists to catch hangs the DATABASE CANNOT BOUND ITSELF. A query
// that is genuinely RUNNING is already bounded: service_role carries
// statement_timeout=30s, so Postgres kills it and returns 57014 (which we
// deliberately never retry). Anything still outstanding past 45s is therefore
// not a statement — it is a stuck acquire or a dead socket, the one case with
// no other stop condition.
//
// So 45s is a ceiling ABOVE the database's own, not a performance target. A
// tighter budget would start cancelling statements Postgres would have finished
// and answered, converting working-but-slow pages into errors — and these pages
// really do render in 11–17s under load. Do not "tune this down" to improve
// perceived latency; that is a query-cost problem, not a timeout problem.
export const DEFAULT_RPC_TIMEOUT_MS = 45_000

// Distinct from any Postgres SQLSTATE so a bound we imposed is greppable in
// logs and never mistaken for something the server reported.
export const RPC_TIMEOUT_CODE = "RPC_TIMEOUT"

interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  /**
   * Called once per retry that is actually SCHEDULED (i.e. the error was
   * classified transient and there is budget left to sleep). Lets a caller
   * COUNT recoveries instead of inferring them from timing — without it, a
   * retry that saves a batch write is indistinguishable from a first attempt
   * that simply worked, and the fix is unmeasurable. Never called on the
   * final attempt, and never for a non-transient error.
   */
  onRetry?: (attemptsSoFar: number, err: PostgrestError) => void
  /**
   * TOTAL wall-clock budget for the whole call INCLUDING retries and backoff —
   * not a per-attempt allowance. rpcWithRetry always settles within roughly
   * this long, which is the property the callers actually need; a per-attempt
   * timeout would silently multiply by `attempts`.
   */
  timeoutMs?: number
  /**
   * Refuse to ISSUE an attempt that would be handed less than this much of the
   * shared budget. Defaults to 0 — every existing caller keeps its exact
   * behaviour — so this is opt-in for callers whose failures are SLOW.
   *
   * 🚨 THE DEFECT IT FIXES, MEASURED (2026-08-29). `timeoutMs` is one budget for
   * the whole call and each attempt gets whatever REMAINS, so `attempts: 3`
   * against slow failures fragments the budget into pieces too small to
   * succeed. Over the 24 h to 2026-08-29 the wallet-backfill family logged 17
   * `RPC_TIMEOUT`s against a 130 s budget and **not one was 130,000 ms**: 14 sat
   * at **3,046–6,278 ms** (two real ~62 s failures, then a crumb) and 3 at
   * ~68,000 ms (one real failure, then half). Every crumb was a doomed attempt.
   *
   * ⚠ THE WORSE HALF IS DIAGNOSTIC, AND IT IS WHY THIS IS WORTH A FLAG.
   * A crumb attempt overwrites the real cause: the tally records
   * `rpc upsert_wmc_batch timed out after 3046ms` — OUR bound — when what
   * actually happened was two pool-acquire or lock timeouts. That is precisely
   * the property `RPC_TIMEOUT_CODE` exists to protect ("a bound we imposed is
   * greppable in logs and never mistaken for something the server reported"),
   * inverted: the log names our bound INSTEAD of the database's problem. With a
   * slice floor the loop breaks and returns the last REAL error instead.
   *
   * ⛔ THIS DOES NOT RECOVER ROWS, and must not be described as if it does. The
   * crumb attempts measured above were all doomed; skipping them loses the same
   * rows a few seconds sooner. What it buys is an accurate `first_chunk_error`
   * and a few seconds back — nothing else. The rows-lost lever is the
   * saturation itself.
   *
   * ⚠ NEVER blocks the FIRST attempt: with no prior error there is nothing
   * truer to report, and the budget is by definition untouched.
   */
  minAttemptSliceMs?: number
}

function timeoutError(ms: number, fn: string): PostgrestError {
  return {
    // NOTE: a timeout is always TERMINAL for the call that raised it. Each
    // attempt is handed the whole REMAINING budget, so an attempt that times
    // out has by definition consumed the rest of it and no retry can follow.
    // That is deliberate, not an oversight: slicing the budget per attempt is
    // the obvious alternative and it is wrong here, because a slice smaller
    // than service_role's 30s statement_timeout would start cancelling
    // statements Postgres would have finished and answered.
    message: `rpc ${fn} timed out after ${ms}ms with no response`,
    details: "",
    hint: "",
    code: RPC_TIMEOUT_CODE,
  } as PostgrestError
}

/**
 * True for the DOMException an aborted fetch produces, in either spelling.
 *
 * `AbortSignal.timeout()` raises `TimeoutError`; an explicit `.abort()` raises
 * `AbortError`. supabase-js may surface either as a returned `error` OR as a
 * rejection depending on version and where the abort lands, so both shapes are
 * normalized at the two exits below.
 */
function isAbortShaped(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name
  if (name === "TimeoutError" || name === "AbortError") return true
  const msg = String((e as { message?: unknown } | null)?.message ?? "").toLowerCase()
  return msg.includes("the operation was aborted")
}

/**
 * Bound one attempt.
 *
 * Two mechanisms on purpose, because they buy different things:
 *  - `.abortSignal()` genuinely CANCELS the request, releasing the socket and
 *    the pool slot. Under saturation that matters — abandoning a request while
 *    it keeps holding a connection makes the pile-up worse.
 *  - the race GUARANTEES we settle. The builder is reached through an `as any`
 *    cast and every test in this repo mocks `.rpc` as a bare async function
 *    with no `.abortSignal`, so the signal cannot be relied on to exist. The
 *    race is what makes the contract true for real clients and mocks alike.
 *
 * ⚠ THOSE TWO MECHANISMS USED TO PRODUCE TWO DIFFERENT ERRORS, and only one of
 * them was ever exercised by a test (2026-08-15). The guard resolves
 * `timeoutError()` — code `RPC_TIMEOUT`, the value this module exports
 * precisely so "a bound we imposed is greppable in logs and never mistaken for
 * something the server reported". The abort path resolved whatever supabase-js
 * made of the DOMException: `TimeoutError: The operation was aborted due to
 * timeout`, with no SQLSTATE and no `RPC_TIMEOUT`. In production the abort wins
 * the race, so the shape that actually escaped was the one with none of the
 * properties this module advertises — that string is the Sentry TITLE of
 * JAVASCRIPT-NEXTJS-1Z (86 users), NEXTJS-26, -23, -22 and -20.
 *
 * ⚠ No test could have caught it: the mocks have no `.abortSignal`, so every
 * test in the repo takes the guard branch by construction. Same shape as the
 * other blind spots in this repo — a mechanism's own derivation deciding what
 * it is able to observe. Hence `__tests__/rpc-with-retry-abort-shape.test.ts`,
 * which supplies a mock that DOES implement `.abortSignal`.
 *
 * Both exits are normalized below, so exactly one timeout shape leaves this
 * function no matter which mechanism fires. A rejection that is NOT abort-shaped
 * is deliberately re-thrown rather than folded into `error` — that would swallow
 * genuine programming faults behind a plausible "timed out" story.
 */
function withDeadline<T>(
  builder: unknown,
  ms: number,
  fn: string,
): Promise<{ data: T | null; error: PostgrestError | null }> {
  const b = builder as {
    abortSignal?: (s: AbortSignal) => unknown
  }

  let pending: unknown = builder
  if (
    typeof b?.abortSignal === "function" &&
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    pending = b.abortSignal(AbortSignal.timeout(ms))
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<{ data: null; error: PostgrestError }>((resolve) => {
    timer = setTimeout(() => resolve({ data: null, error: timeoutError(ms, fn) }), ms)
  })

  return Promise.race([
    pending as Promise<{ data: T | null; error: PostgrestError | null }>,
    guard,
  ])
    .then((settled) => {
      // The abort landed as a RETURNED error (the usual supabase-js shape).
      if (settled?.error && isAbortShaped(settled.error)) {
        return { data: null, error: timeoutError(ms, fn) }
      }
      return settled
    })
    .catch((thrown: unknown) => {
      // The abort landed as a REJECTION. Without this the throw escapes
      // rpcWithRetry entirely, past every caller that destructures
      // `{ data, error }` — a contract break, not just a wording difference.
      if (isAbortShaped(thrown)) {
        return { data: null, error: timeoutError(ms, fn) } as {
          data: T | null
          error: PostgrestError | null
        }
      }
      throw thrown
    })
    // Always clear the timer. A dangling one holds the event loop open, which
    // on a serverless invocation delays teardown and in vitest leaks handles.
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
}

function isTransient(err: PostgrestError | null | undefined): boolean {
  if (!err) return false
  // Postgrest exposes the SQLSTATE on .code; also accept connection-error
  // shapes whose code starts with "08" (any 08xxx is connection-class).
  const code = (err as any)?.code
  if (typeof code === "string") {
    // Checked first: these carry a message the heuristics below would match.
    if (NEVER_RETRY_CODES.has(code)) return false
    if (TRANSIENT_CODES.has(code)) return true
    if (/^08\d{3}$/.test(code)) return true
    // 42xxx — explicit logic class. Never retry these.
    if (/^42\d{3}$/.test(code)) return false
  }
  // Network-y messages from the JS client (fetch failures, AbortError) are
  // transient as well. Postgrest sometimes folds them into a string-only
  // error with no SQLSTATE.
  const msg = (err.message || "").toLowerCase()
  // Guard the SQLSTATE-less form of the same thing: a 57014 that arrives with
  // no .code still must not be retried.
  if (msg.includes("canceling statement due to statement timeout")) return false

  // ── PostgREST schema-cache errors: ONE of the two is retryable ────────────
  //
  // ⚠ These two messages look alike and mean opposite things. Match the exact
  // wording, never a bare "schema cache".
  //
  //  • PGRST002 "Could not query the database for the schema cache. Retrying."
  //    PostgREST could not INTROSPECT — it failed to reach the database to
  //    rebuild its cache, typically while the pool is saturated or just after
  //    DDL. It is transient by construction, and PostgREST says "Retrying."
  //    itself. RETRY.
  //
  //  • PGRST205 "Could not find the table/function ... in the schema cache"
  //    The cache loaded FINE and the object genuinely is not there — a deploy
  //    or naming bug. Retrying just burns the budget to fail identically.
  //    NEVER RETRY. It is excluded first so the broader test below cannot
  //    swallow it.
  //
  // WHY THIS IS HERE (2026-08-13): this was the single largest real
  // user-facing error on the platform — Sentry JAVASCRIPT-NEXTJS-1Z, **81
  // users / 84 events since 2026-07-18**, plus NEXTJS-26 (edition) and
  // NEXTJS-20 (player), ~97 events in 7 days. All three already ran through
  // rpcWithRetry; none of the heuristics above matched the message, so a
  // self-declared-retryable failure was never retried once.
  //
  // ⚠ MEASURED AFTER THE FACT, AND IT LIMITS WHAT THIS CLAUSE BUYS. The cause
  // is not random saturation: it is SELF-INFLICTED by our own migrations. Every
  // schema-cache event in the trailing 24 h fell in ONE 11-second window —
  // 17:20:15 / :21 / :23 / :26 Z across the pack, edition and player pages —
  // and `audit_20260813_pack_rips_collection_block_height_index` was applied at
  // **17:20:05 Z**. Applying a migration invalidates PostgREST's schema cache,
  // and every request during the reload gets a user-facing 500.
  //
  // The reload window is therefore ~10-20 SECONDS, while this function's retry
  // schedule is 3 attempts at 50 ms + 200 ms — about **250 ms of retrying**. So
  // classifying it transient is correct in KIND but does NOT, on its own, absorb
  // the dominant cause; all three attempts land inside the first quarter-second
  // of a twenty-second outage. Do not read this clause as "NEXTJS-1Z is solved".
  //
  // Lengthening the backoff for THIS class specifically would cover it, and the
  // 45 s budget has room — but it trades a 500 for a ~20 s page render that
  // holds a lambda, so it is a product call rather than an obvious win, and it
  // is filed rather than taken. See docs/overnight/inbox/2026-08-13T2320Z-*.
  if (msg.includes("in the schema cache")) return false
  if (msg.includes("could not query the database for the schema cache")) return true
  if (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("timeout") ||
    // Supavisor/pgbouncer pool exhaustion surfaces as a plain-message error
    // (often no SQLSTATE): "Timed out acquiring connection from connection
    // pool." Note "timed out" (two words) is NOT caught by "timeout" above.
    msg.includes("timed out") ||
    msg.includes("connection pool") ||
    msg.includes("acquiring connection")
  ) {
    return true
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * The shared retry loop behind BOTH `rpcWithRetry` and `queryWithRetry`.
 *
 * Extracted rather than copied, for the reason `withQueryDeadline` gives two
 * paragraphs below: *one mechanism with one set of edge cases beats two that can
 * drift*. `attempt` is handed the REMAINING budget and must produce a fresh
 * attempt each call — for a PostgREST builder that means calling the factory
 * again, because a builder is a single-use thenable.
 */
async function retryLoop<T>(
  attempt: (remainingMs: number) => Promise<{ data: T | null; error: PostgrestError | null }>,
  label: string,
  opts: RetryOptions
): Promise<{ data: T | null; error: PostgrestError | null }> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const base = Math.max(1, opts.baseDelayMs ?? 50)
  const budget = Math.max(1, opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS)
  const minSlice = Math.max(0, opts.minAttemptSliceMs ?? 0)
  const deadline = Date.now() + budget

  let lastErr: PostgrestError | null = null
  for (let i = 0; i < attempts; i++) {
    // Each attempt may use whatever is LEFT of the shared budget, so the whole
    // call still settles within `budget` no matter how the attempts fall.
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      lastErr = lastErr ?? timeoutError(budget, label)
      break
    }
    // A slice too small to be a real attempt is worse than no attempt: it is
    // doomed AND it overwrites the true cause with our own bound. Guarded on
    // `lastErr` so the first attempt always runs — see minAttemptSliceMs.
    if (lastErr !== null && remaining < minSlice) break
    const { data, error } = await attempt(remaining)
    if (!error) return { data: (data as T | null) ?? null, error: null }
    lastErr = error
    if (i === attempts - 1) break
    if (!isTransient(error)) break
    // Exponential backoff: 50ms, 200ms, 800ms (with the default base of 50).
    // Never sleep past the deadline — waiting out a budget we no longer have
    // would spend the caller's time to reach a retry that cannot run.
    const delay = Math.min(base * Math.pow(4, i), Math.max(0, deadline - Date.now()))
    if (delay <= 0) break
    opts.onRetry?.(i + 1, error)
    console.log(
      `[rpc-with-retry] transient error on ${label} attempt ${i + 1}/${attempts}: ${error.message || (error as any)?.code || "unknown"} — retrying in ${delay}ms`
    )
    await sleep(delay)
  }
  return { data: null, error: lastErr }
}

export async function rpcWithRetry<T>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  opts: RetryOptions = {}
): Promise<{ data: T | null; error: PostgrestError | null }> {
  return retryLoop<T>(
    (remaining) => withDeadline<T>((client.rpc as any)(fn, args), remaining, fn),
    fn,
    opts
  )
}

/**
 * `withQueryDeadline` + retry, for a **table read whose failure discards a whole
 * batch run**. Takes a FACTORY, not a builder — see below.
 *
 * ⚠ WHY THIS EXISTS ALONGSIDE `withQueryDeadline`, WHICH DELIBERATELY DOES NOT
 * RETRY. That function's reasoning — *"a retry doubles the worst-case hold on a
 * pool that is already the thing saturating"* — is correct **for a page render a
 * human is waiting on**, where the cost of retrying is paid by that reader. It is
 * the wrong trade for a background sweep, and `fmv-recalc` is the proof: on
 * 2026-08-16 it wrote **zero rows for 12.4 h across 17 consecutive runs**, every
 * one dying on a SINGLE unretried chunk fetch (`sales_refetch_failed: 1 chunk
 * fetch errors`) at 45–139 s against a 300 s ceiling, leaving its cursor pinned at
 * offset 0. Not retrying did not spare the pool anything — the route re-ran the
 * whole page on the next cron tick and failed the same way. **A retry here
 * REPLACES a guaranteed full re-run with a cheap second attempt.**
 *
 * ⚠ TAKES A FACTORY BECAUSE A POSTGREST BUILDER IS SINGLE-USE. `.from().select()`
 * returns a thenable that fires its request once; awaiting the same object twice
 * does not re-issue it, so a retry that closed over one builder would "retry" by
 * re-reading the first attempt's settled result — passing tests, fixing nothing.
 * Each attempt calls `build()` to construct a fresh query.
 *
 * Default budget/attempts match `rpcWithRetry`. A batch caller should pass a
 * LONGER `baseDelayMs`: the default ~250 ms of backoff is sized for a page render
 * and lands entirely inside a saturation spell that lasts seconds.
 */
export async function queryWithRetry<T>(
  build: () => unknown,
  label: string,
  opts: RetryOptions = {}
): Promise<{ data: T | null; error: PostgrestError | null }> {
  return retryLoop<T>((remaining) => withDeadline<T>(build(), remaining, label), label, opts)
}

/**
 * Bound a PostgREST **table-read builder** (`.from(...).select(...)...`) with the
 * same wall-clock deadline `rpcWithRetry` gives an `.rpc()` call.
 *
 * WHY THIS EXISTS. `rpcWithRetry` is RPC-shaped — it takes `(client, fnName,
 * args)` and calls `.rpc()` itself — so a `.from()` builder cannot go through it.
 * The edition page's two remaining table reads were therefore still unbounded
 * after the 2026-08-13 RPC fix, and both are live production error sources
 * ("Timed out acquiring connection from connection pool", 19 + 5 events). An
 * unbounded read there does not just fail: it parks the render until Vercel's
 * 300 s kill and leaves a streamed section spinning forever.
 *
 * ⚠ This is deliberately a THIN WRAPPER over the existing `withDeadline`, not a
 * second primitive. The filing that scoped this work suggested writing one, but
 * `withDeadline` only ever probes for `.abortSignal` — it never touches anything
 * RPC-specific — so it already accepts any thenable builder. One mechanism with
 * one set of edge cases beats two that can drift.
 *
 * ⚠ NO RETRY, unlike `rpcWithRetry`. These are supplementary sections; a retry
 * doubles the worst-case hold on a pool that is already the thing saturating.
 * The deadline releases the slot, which is the half that matters here.
 *
 * Keeps the 45 s default on purpose — see `DEFAULT_RPC_TIMEOUT_MS`. A tighter
 * client bound would pre-empt Postgres's own `statement_timeout=30s`, which is
 * the handled path that turns a slow query into a retryable error boundary.
 */
export function withQueryDeadline<T>(
  builder: unknown,
  label: string,
  timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
): Promise<{ data: T | null; error: PostgrestError | null }> {
  return withDeadline<T>(builder, Math.max(1, timeoutMs), label)
}
