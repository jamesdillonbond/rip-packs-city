// lib/og/og-fetch.ts
//
// THE ONE BOUNDED FETCH THE OG CARDS ARE ALLOWED TO MAKE.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// An OG card is rendered while a social crawler holds the connection open. Every
// data read those routes made was a bare `fetch()` with NO timeout — 30 call
// sites across 28 files, measured 2026-08-29, zero of them carrying an
// `AbortSignal`. CLAUDE.md's "Bound every `fetch` — no default timeout" existed
// the whole time; this was the largest single violation of it in the repo.
//
// It is not hypothetical. The sibling case is on record: `lib/og/brand-fonts.ts`
// fetched the brand TTFs unbounded, and on one CI runner that stalled a card
// that renders in 83 ms out to vitest's 60,000 ms timeout (run 4202). Same
// shape, same path, different URL.
//
// ── WHY 10 SECONDS, AND WHAT IT COSTS ────────────────────────────────────────
// ⚠ THIS IS A PRODUCT BUDGET, NOT A LATENCY PERCENTILE, and the difference is
// the whole argument. The question is not "how long do these APIs take" — it is
// "after how long is a degraded card better than no card", and a crawler that is
// still waiting has already shown the reader a bare URL.
//
// The cost is stated rather than hidden. `/api/public/insights/pack-sniper`,
// production runtime logs, 6 h to 2026-08-30T04:33Z, n=40: min 385 ms, median
// ~1.9 s, tail 6.1 / 6.7 / 7.8 / 7.8 / 10.9 s. At a 10 s bound exactly ONE of
// those 40 would have been aborted into the honest fallback instead of
// rendering. A 5 s or 6 s bound — the tempting round numbers — would abort four,
// which is trading a real defect for a bigger one.
//
// ⚠ That is ONE board over ONE window and it is a SAMPLE, NOT A CENSUS. It is
// also the PAGE's request shape (`limit=50`), while a card asks for `limit=3`
// (cheaper) or `limit=200` for its count (comparable or worse). Re-measure
// before moving this number; do not quote it.
//
// ── WHAT AN ABORT DOES, WHICH IS THE PART THAT HAD TO BE CHECKED ─────────────
// Every one of these call sites sits inside a `try` whose `catch` leaves the
// route's `fetched` flag FALSE, so an abort lands on the honest "couldn't load
// this" branch (lib/og/board-empty-copy.ts) and never on a fabricated empty
// state. That was verified per call site before this shipped — a bound that
// turned a slow read into a confident "0 sales this week" would be a far worse
// defect than the hang it fixed.
//
// ── THE TWO DELIBERATE NON-CALLERS ───────────────────────────────────────────
// `lib/og/brand-fonts.ts` bounds its own font fetch at 5 s (a shorter, separate
// budget: a card without brand fonts still renders, so waiting is worth less),
// and `lib/og/img-data.ts` drives its own `AbortController`. Both are exempted
// by name in the guard rather than silently skipped.

/**
 * Milliseconds a card will wait for one read before rendering degraded.
 *
 * ⚠ A DATED SAMPLE informs this, not a constant — see the measurement above.
 */
export const OG_FETCH_TIMEOUT_MS = 10_000

/**
 * ⚠ ONE PLACE THIS BOUND DOES NOT REACH, CHECKED IN NEXT'S SOURCE RATHER THAN
 * ASSUMED. `app/api/og/share/route.tsx` is the only OG read that uses Next's
 * data cache (`next: { revalidate: 300 }`); the other 29 are `cache: "no-store"`
 * and are unaffected by any of this.
 *
 * Two things had to be true for that route and both are:
 *   1. A `signal` does NOT opt the request out of the data cache. Next
 *      destructures it out of `init` and re-attaches it
 *      (`next/dist/server/lib/patch-fetch.js`, ~line 623) — the cache opt-outs
 *      are `no-cache`/`no-store` and segment config, not the presence of a
 *      signal. So this bound did not silently turn a cached read into an
 *      uncached one.
 *   2. On a BACKGROUND REVALIDATION Next deliberately drops it
 *      (`signal: isStale ? undefined : signal`, "don't pass through signal when
 *      revalidating"). That revalidation is Next's own work, off the request a
 *      crawler is waiting on, so it is outside what this bound is for — but
 *      "every OG read is bounded" is therefore not literally true, and the
 *      exception belongs here rather than being rediscovered as a surprise.
 */

/**
 * `fetch` with a deadline. Drop-in: same arguments, same return.
 *
 * A caller that supplies its own `signal` keeps it — the helper adds a bound
 * where there was none and never overrides one that was chosen deliberately.
 * (Composing the two would need `AbortSignal.any`, which is not available on
 * every runtime these routes deploy to; 5 of the 6 emoji routes are `edge`.)
 */
export function ogFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(OG_FETCH_TIMEOUT_MS),
  })
}
