# Two findings from the coverage pass's tail — 2026-08-20 (PT)

Both surfaced while working the filing's item 3 (branch coverage on the worst
ingest routes). Neither is shipped; both need a decision rather than a diagnosis.

---

## 1. `app/api/cron/pinnacle-listings-reconcile` is fully dead, and its coverage number is misleading in a way that will keep drawing attention

⚠ **The 2026-08-20 filing named this route as the #1 branch-coverage target** —
28.6% branches / 40.7% statements, the worst in `app/api`. **That was wrong, and
the reason is worth recording: the number is not a coverage gap at all.**

The route opens with `const ASK_UNIFY_RETIRED = true` and returns inside the
`if (ASK_UNIFY_RETIRED)` block. Everything below — ~73 of its 146 lines — is
**unreachable by construction**, parked for rollback per the runbook in
`docs/strategy/pinnacle-grain-migration-2026-07-17.md`. Two test files
(`api-cron-pinnacle-listings-reconcile.test.ts` and `…-deep.test.ts`) already
cover the live path. Writing tests for the rest would be testing dead code, and
any future sweep that ranks by coverage % will land on this route again.

**And the retirement is now complete.** The route's own comment set the
condition: *"logs a no-op run so the cadence watchlist stays green until the
cron-job.org entry is deleted (then set the watchlist row is_active=false)"*.
Measured 2026-08-20:

| check | value |
|---|---|
| pg_cron jobs matching `pinnacle_listings_reconcile` | **0** |
| `pipeline_cadence_watchlist.is_active` | **false** |
| `pipeline_runs` rows in the ~72h window | **0** |
| retired-no-op rows ever logged in that window | **0** |

Zero runs means the cron-job.org entry is gone too — nothing is calling it. So
the stated precondition for cleanup has been met on every axis.

**Decision needed (Trevor's, not mine):** delete the route and its two test
files, or keep the parked rollback path. I did **not** delete it — it carries a
documented rollback runbook, and removing a rollback path is not a call a
coverage pass should make unilaterally. If it is deleted, `pinnacle_listings_reconcile()`
and `pinnacle_editions.ask_price` are the other two halves still parked.

⚠ **Whatever is decided, the coverage-ranking trap should be closed**, or the
next pass re-derives the same wrong target. Cheapest option: a one-line comment
at the top of the route saying the low coverage is deliberate dead code.

---

## 2. The OG card sweep makes live outbound network calls inside the blocking CI job

`__tests__/api-og-cards-render-sweep.test.ts` stubs `globalThis.fetch`
correctly, so the *route's* own fetches are contained. But `@vercel/og`'s satori
renderer reaches the network **through its own path**, not through
`globalThis.fetch`, whenever a glyph is missing from the supplied fonts. Observed
repeatedly in a full run:

```
Failed to load dynamic font for ★ . Error: Failed to download dynamic font. Status: 400
    at loadGoogleFont (…/@vercel/og/index.node.js:21358:11)
```

**This is not currently a failure** — the download fails, the card renders
without the glyph, and the test passes. Recorded because:

- it is **real outbound I/O in a blocking unit-tests job**, so the job's runtime
  and reliability depend on an external host that is already returning 400;
- it runs **per rendered card**, and the sweep renders many;
- a test suite that reaches the network is flaky by construction, and this same
  run is the one where `api-profile-trophy-case-pdf` timed out (fixed separately
  in `7969f951`). ⚠ **I did not establish that the two are related** — the PDF
  timeout is fully explained by a cold `pdf-lib` import under parallel load, and
  the network calls are a separate observation. Do not merge them into one story
  without measuring.

**Options, in increasing cost:** keep the `★` out of OG copy; supply a font that
covers it so satori never asks; or stub satori's loader. The first is a copy
change and probably the cheapest, but it is a design call.

---

## What I checked and did NOT find

- **Sibling heavy-import test files.** Swept for other test files exercising
  routes that import `pdf-lib` or `@vercel/og`: `api-profile-trophy-case-pdf` is
  the only one, and no test file in the repo sets an explicit timeout. So the
  timeout fix is correctly a targeted one rather than the first of a family.
