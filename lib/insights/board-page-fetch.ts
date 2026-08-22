// lib/insights/board-page-fetch.ts
//
// The server-side initial fetch every `/insights/**` board page performs.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Eight board pages had byte-identical copies of this block:
//
//     const fetchedAt = new Date().toISOString()
//     try {
//       const rows = await fetchSomething(supabaseAdmin, …)
//       return { rows, fetchedAt, ok: true }
//     } catch (e) {
//       console.error("[insights/<slug>] initial fetch", e instanceof Error ? e.message : e)
//       return { rows: [], fetchedAt, ok: false }
//     }
//
// Every one of them imported `supabaseAdmin` for the sole purpose of handing it
// to a fetcher that already lives in `lib/`. That import is what put each page
// on `__tests__/server-page-data-access-ratchet.test.ts`, and
// `app/**/page.tsx` is measured by NEITHER coverage gate — so eight copies of
// the one branch that decides whether an outage renders as a fact were sitting
// in the only part of the tree no gate watches.
//
// Centralising it swaps eight untested copies for one tested function AND drops
// eight pages off the ratchet, because the page no longer needs a client.
//
// ── THE PROPERTY THIS PROTECTS ─────────────────────────────────────────────
// `ok` answers *did the READ succeed*, never *were there rows*. It is what
// `summarizeDegraded([boardStatus(label, ok)])` turns into the visible notice,
// and without it a statement timeout renders as an EMPTY BOARD at HTTP 200 —
// byte-identical to "nothing matched", which on these surfaces is a market
// claim. See lib/insights/board-status.ts.
//
// ⚠ `fetchedAt` is returned even on a FAILED read, deliberately, and it is the
// one field here that could mislead on its own: it is the moment we ASKED, not
// the age of the data. That is safe only because it always travels with `ok`,
// and the caller renders the degraded notice from `ok`. **Do not use
// `fetchedAt` as a freshness signal without checking `ok`** — a caller that
// showed "updated just now" beside a failed read would be making exactly the
// claim this module exists to prevent.

import { supabaseAdmin } from "@/lib/supabase"
import { BOARD_LIVE_TIMEOUT_MS } from "@/lib/insights/board-cache"

export interface BoardPageFetch<T> {
  /** The fetched payload, or the caller's `fallback` when the read failed. */
  data: T
  /** When we ASKED — not the age of `data`. Only meaningful alongside `ok`. */
  fetchedAt: string
  /** Did the READ succeed. NOT "were there rows". */
  ok: boolean
}

/**
 * Run a board page's initial server-side read with the shared failure policy.
 *
 * @param label   Board name for the log line and the degraded notice, e.g.
 *                "Rookie board". Kept human-readable because it is what a
 *                reader sees, not just what an operator greps.
 * @param fallback What `data` becomes when the read fails. Pass the SAME empty
 *                value the client renders for a genuinely empty board — the
 *                honesty comes from `ok`, not from a distinguishable payload.
 * @param fetcher Receives the service-role client. Supplying it here is the
 *                whole point: the page never imports one, so it stays off the
 *                data-access ratchet and out of the unmeasured tree.
 *
 * Never throws — a board page that throws renders an error boundary instead of
 * a board, and these sections are worth serving degraded.
 */
export async function fetchBoardForPage<T>(
  label: string,
  fallback: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetcher: (db: any) => Promise<T>,
  timeoutMs: number = BOARD_LIVE_TIMEOUT_MS,
): Promise<BoardPageFetch<T>> {
  // Stamped BEFORE the read so it reflects when we asked, matching what these
  // pages did individually.
  const fetchedAt = new Date().toISOString()
  try {
    const data = await withBoardBudget(fetcher(supabaseAdmin), label, timeoutMs)
    return { data, fetchedAt, ok: true }
  } catch (e) {
    console.error(`[insights/${label}] initial fetch`, e instanceof Error ? e.message : e)
    return { data: fallback, fetchedAt, ok: false }
  }
}

/**
 * Bound a board page's server-side read, REJECTING when it overruns.
 *
 * ── WHY THIS EXISTS, AND WHY IT REJECTS RATHER THAN RETURNING A FLAG ───────
 * Every `/insights` server page already has an honest-degraded path — a
 * try/catch that sets `ok:false` and renders `DegradedDataNotice`. What twelve
 * of them lacked was any way to REACH it from a slow read, because
 * **a query that is merely SLOW errors nowhere.** Rejecting on the budget feeds
 * the branch each page already has, so bounding a page is a one-line change and
 * cannot accidentally introduce a second, divergent failure policy.
 *
 * ── THE BOUND IS A BUILD-INTEGRITY PROPERTY, NOT JUST A UX ONE ─────────────
 * These pages are PRERENDERED. Next gives each page 60s to export, retries 3×,
 * then kills the whole build. Two production deploys ERRORed on 2026-08-15
 * within ten minutes — `/insights/market` and `/insights/market-pulse`, a
 * DIFFERENT page each time, neither touched by the commit that failed (one was
 * tests-only) — both on "Timed out acquiring connection from connection pool"
 * during a DB saturation spell. With reads unbounded, every deploy is a coin
 * flip on whichever board the saturation lands on.
 *
 * Third instance of one class: `BOARD_LIVE_TIMEOUT_MS` was created for it on
 * first-mint and `SET_DETAIL_TIMEOUT_MS` fixed it on `/analytics/sets`. Both
 * prior fixes were applied to the ONE page that failed rather than to the shape,
 * which is why it came back twice.
 *
 * ⚠ The abandoned query keeps running server-side — supabase-js has no cancel.
 * We stop WAITING on it; we do not stop it. That is the intended trade: the page
 * (or the build) proceeds on an honest degraded notice instead of blocking on a
 * throttled DB.
 *
 * ⚠ The timer is CLEARED in a `finally`. Without that, a fast read still leaves
 * a pending 8s timer, and during a static export that keeps the event loop
 * alive — turning a bound meant to speed the build up into a source of delay.
 */
export async function withBoardBudget<T>(
  p: Promise<T>,
  label: string,
  timeoutMs: number = BOARD_LIVE_TIMEOUT_MS,
  /**
   * Log/message namespace. Defaults to `insights/` so all 36 existing call
   * sites keep their exact message. Added 2026-08-22 for the FIRST caller
   * outside /insights — `lib/entity/popular-on-collection-fetchers.ts`, which
   * hit this same class on the /overview pages. An `[insights/...]` prefix on a
   * non-insights surface is not a cosmetic wart: it sends an operator grepping
   * for the wrong subsystem, and this repo has already lost time to a
   * plausible-looking label naming the wrong object.
   */
  prefix: string = "insights/",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`[${prefix}${label}] read exceeded ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The `fetchAllPaged` flavour of the same bound: RESOLVES with an `error` string
 * instead of rejecting.
 *
 * ⚠ WHY A SECOND FUNCTION RATHER THAN REUSING THE REJECTING ONE. The pages that
 * page their reads (`market`, both `*-pack-market` boards, `allday-pack-reality`)
 * have an `if (error)` degraded branch and NO try/catch. Handing them a rejection
 * would escape the function and throw during the static export — which fails the
 * build just as surely as the hang it was meant to prevent, only faster and with
 * a more confusing message. Matching `fetchAllPaged`'s own `{ rows, error }`
 * contract routes a timeout into the branch each page already has.
 *
 * ⚠ A PAGED read is the worst shape for an export budget: it multiplies one slow
 * round trip by the page count, so these are the pages most likely to blow it —
 * `/insights/market` is one of the two that actually did.
 */
export async function withPagedBoardBudget<T>(
  p: Promise<{ rows: T[]; error: string | null }>,
  label: string,
  timeoutMs: number = BOARD_LIVE_TIMEOUT_MS,
): Promise<{ rows: T[]; error: string | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<{ rows: T[]; error: string | null }>((resolve) => {
        timer = setTimeout(
          () => resolve({ rows: [], error: `[insights/${label}] read exceeded ${timeoutMs}ms` }),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
