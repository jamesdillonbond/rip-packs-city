# `/api/search` has no smoke probe, and it now has two consumers

**Filed** 2026-08-14 02:04Z (2026-08-13 19:04 PT) by Claude Code (interactive, concierge CX/UX pass).
**Status** QUEUED — read-only finding, deliberately NOT auto-shipped. See "Why this wasn't just fixed".
**Severity** medium. No user-visible defect today; this is a monitoring gap on a live public route.

## The gap

`/api/search` (public GET, shipped 2026-08-11) is **not probed by `/api/smoke-test`**. The probe list
covers `/api/badges`, `/api/fmv`, `/api/market`, `/api/og`, `/api/pack-listings`, `/api/profile`,
`/api/public`, `/api/sniper-feed`, `/api/support-chat`, `/api/wallet-search` — search is absent.

It now has **two** consumers, which is what moved this from tidy-up to worth-filing:

1. `components/search/GlobalSearch.tsx` — the site's only real catalog search, in `GlobalSiteHeader`.
2. **`search_catalog`**, the concierge tool added 2026-08-13 (`9d383d6e`). It is the ONLY path by which
   the assistant can answer a narrative query ("the Lillard game winner").

So if the route or `rpc_search_catalog` breaks, nothing pages. The header panel shows its empty state and
the concierge says it could not check — both honest, both silent.

## ⚠ The naive fix is theatre — do not just add a `checkUrl` line

`checkUrl(..., expectJson = true)` asserts only that the body parses to an object. `/api/search` returns
**HTTP 200 with `{ results: [], meta: {...} }`** for a legitimate no-match, so that probe passes while the
index is empty, the RPC is broken, or the prose column has been wiped. Same shape as the board-liveness
probe that timed `SELECT count(*)` — a query the planner prunes, so it could not observe the thing it
claimed to watch.

A probe here has to assert a **known-stable query returns rows**, which needs a custom `time()` block
rather than the shared helper.

## Suggested shape

- Query something structurally guaranteed and collection-scoped, e.g. `q=lillard&collection=nba-top-shot`,
  and assert `results.length > 0` **and** that at least one hit carries a non-empty `href`
  (a wrong `href` 404s on click and is invisible to a row-count check — `lib/search/href.ts` exists
  precisely because of that failure mode).
- **Treat a 503 as SOFT/inconclusive, not a hard fail.** The route deliberately answers 503 rather than
  `200 {results: []}` on a DB failure, and this instance's disk-IO saturation spells are routine; a hard
  arm here would go red on capacity and train the operator to skim past it — the cost already paid for
  with `ufc_fmv_stale_hours`. `TRANSIENT_STATUS` + one retry already exists in `checkUrl`; mirror it.
- Consider a **second, cheap arm asserting `meta.coverage` is present**. The concierge's honesty rule
  depends on it: without `coverage`/`note` the bot cannot tell "we hold no description for that moment"
  apart from "no such moment", and that contract can be broken silently by an edit to the route or by
  `edition_description_coverage` going away — no type or test outside `/api/search`'s own suite guards it.

## Counts to update in the same commit

`__tests__/api-smoke-test-deep.test.ts` pins the envelope in three places — all must move together:
- `expect(env.total).toBe(55)` (line ~278)
- `expect(env.hardTotal).toBe(43)` (line ~281)
- `expect(env.total).toBe(58)` (line ~642 — a different scenario; verify its delta separately rather
  than assuming +1 applies identically)

## Why this wasn't just fixed

Three reasons, recorded so nobody re-derives them:

1. **It is not a defect I introduced.** Search shipped unprobed on 08-11; my change added a consumer.
   The concierge tool degrades honestly without it (a failed search returns `status: "error"`, never
   `no_results`, and the system prompt requires the bot to say it could not check), so there is no
   user-facing harm waiting on this.
2. **`app/api/smoke-test/route.ts` was under active concurrent edit** by at least two other sessions on
   2026-08-13, and the fix touches three pinned counts across two scenarios. A mistake there reds the
   blocking `unit-tests` job for every session at once.
3. **The useful version is not a one-liner.** Per above, a probe that satisfies the existing helper would
   pass during exactly the outage it is meant to catch, so shipping the cheap version would be worse than
   the gap — it would close the ticket while leaving the route unwatched.

## Verification done at filing

- Probe list read from `app/api/smoke-test/route.ts` (no `/api/search`).
- `rpc_search_catalog('lillard game winner', NULL, 5)` live: returns the For the Win moments, 3 rows.
- `edition_description_coverage` live: Top Shot 5,885/13,203 (44.6%); All Day, Golazos, UFC all 0.
- No new Sentry issues in the 3h covering the four 08-13 concierge deploys.
