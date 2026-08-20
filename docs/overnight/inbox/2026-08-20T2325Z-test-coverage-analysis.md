# Test-coverage analysis — 2026-08-20 (PT)

All three gates re-run from a clean `npm ci` in this sandbox. Every number below is a
**dated sample measured in this session**, not a quote from prose — re-derive before acting.

---

## 1. Where the suite actually stands (measured, not quoted)

| gate | statements | branches | functions | lines | thresholds | margin |
|---|---|---|---|---|---|---|
| primary (`vitest.config.ts`) | **91.79** (44238/48193) | **79.25** (33500/42271) | **93.55** (5005/5350) | **93.87** | 91.3 / 78.6 / 93.1 / 93.4 | +0.49 / +0.65 / +0.45 / +0.47 |
| components | **90.73** (13470/14846) | **81.91** | **89.25** (3490/3910) | **93.64** | 90.3 / 81.6 / 89.1 / 93.2 | +0.43 / +0.31 / **+0.15** / +0.44 |
| workers | **85.44** (1797/2103) | **72.54** | **84.25** (182/216) | **88.37** | 85.1 / 72.1 / 83.8 / 88.1 | +0.34 / +0.44 / +0.45 / +0.27 |

1312 test files, **14,162 tests, all passing**. Primary 440s, components 279s, workers 6.3s.

⚠ The component **functions** margin is **6 functions of 3,910**. `testing-and-ci.md` records a
±0.1pt wobble on an unchanged tree at exactly this metric, whose one identified cause
(`CollectionTabClient`'s intermittently-vacuous Load-More case) was fixed but explicitly *not*
proven to be the only one. That margin is one flaky suite away from a red build on someone
else's commit.

### Breadth is finished. Depth is not.

- **456/456** `app/**/route.ts` are referenced by a test.
- **290/295** `lib/` modules are referenced by a test.
- **24/24** worker source files appear in the workers coverage report.

So the useful question is no longer *what is untested* — it is **which branches never execute**.
Statements sit at ~92%; branches at ~79%. That 13-point spread is almost entirely error handling,
which on this codebase is the honesty layer.

### Where the ~8,771 uncovered primary-gate branches live

| bucket | files | uncovered branches |
|---|---|---|
| `app/api/**` | 499 | **7,586 (86%)** |
| `lib/chains` | 25 | 212 |
| `lib/concierge` | 6 | 73 |
| everything else in `lib/` | ~260 | < 55 each |

`lib/` is in good shape. **The API layer is the gap**, and inside it:

| family | files | branch % | uncovered branches |
|---|---|---|---|
| `after()` routes | 109 | **71.9** | **3,734** |
| ingest / cron / indexer | 96 | 71.4 | 2,626 |
| OG cards | 44 | 73.8 | 385 |
| `app/api/public/**` boards | 37 | **80.3** | 168 |

**`after()` routes are 22% of the API files and 49% of its uncovered branches.** The public boards —
the surface with the most honesty work already done — are the best-covered family. That correlation
is the whole argument for what follows.

---

## 2. Proposed areas, ranked

### (1) The `after()` invocation heartbeat: 58 of 62 cron routes don't write one, and nothing guards it

CLAUDE.md states the rule outright: *"Any `after()` route needs an invocation heartbeat written
BEFORE the work, under a separate `<pipeline>-heartbeat` name, or a killed tick is
indistinguishable from a cron that never fired."* It is backed by a real incident — **21 silent
`maxDuration` kills over 2 months**, invisible because `try/catch` cannot catch the kill and it
takes the terminal `pipeline_runs` insert with it *after* the 202 already told the caller success.

Measured today:

- **62** cron-ish `after()` routes (`app/api/cron/**`, `*-indexer/`, `app/api/ingest/**`).
- **49** write a terminal `pipeline_runs` row.
- **4** write the invocation heartbeat.
- **There is no `lib/` helper.** All four hand-roll it (`grep -rln heartbeat lib/` → nothing).
  `upsert_cron_heartbeat` has exactly two callers repo-wide.
- Of those 4, **3 have no test that names the heartbeat at all**
  (`cron/prune-logs`, `ingest/candy-offers`, `candy-listings-indexer`).

This is the one documented honesty class with **no ratchet and no ban**, while `?? 0` divisors,
unordered `.range()` pagination, client failure-collapse and server-page data access all have one.

**Proposal**
1. Extract `lib/pipeline/heartbeat.ts` — one helper, unit-tested, so the shape stops being
   copy-paste. (The copy-paste precondition is already met: four hand-rolled instances.)
2. Add `__tests__/after-route-writes-invocation-heartbeat-ratchet.test.ts`, `BUDGET = 58`,
   lowered in the same commit that converts a route. Derive the population from a **tree walk**
   over `app/api/**/route.ts` matching `after(`, not a curated list.
3. Per adopting route, one behavioural test asserting the **ordering**: the heartbeat insert
   resolves before the work begins.

⚠ **Be honest about what that proves.** A vitest test cannot simulate a `maxDuration` kill. It can
only pin the ordering — which is precisely the property that makes the correlation detection
(heartbeat row with no terminal row) work. Say so in the test header; do not let the test's title
promise kill-detection.

---

### (2) `lib/edition/legacy-redirect.ts` is at 0% executed coverage — and it was extracted *specifically* to be testable

The sharpest single instance in this sweep, because it is the repo's own pattern failing at the
last step.

- 58 lines. Imported by `app/edition/[id]/page.tsx` (live).
- **0.0% statements, 0.0% branches.**
- Its header explains why it exists: the page collapsed a failed read into `notFound()`, so a
  statement timeout *"handed a hard 404 for an edition that exists, to precisely the audience least
  likely to try again and most likely to record the 404."*
- The only test that touches it — `server-pages-error-vs-absent-guard.test.ts:372` — reads it as
  **source text** (`read("lib","edition","legacy-redirect.ts")`) and never executes it.

The source guard itself is well-built: it pins both directions (`ok:false` on failure, `ok:true` on
a genuine miss), pins the ordering of `throw` before `notFound()`, and bans the old
`if (error || !data` condition. But by the repo's own standard — *"it pins the EXPRESSIONS, not the
behaviour"* — it is a tripwire. It cannot see whether `lookupLegacyEdition` actually **reaches**
its error branch, and supabase-js **returns** errors rather than throwing, which is the exact
mechanism that produced this defect class ~24 times.

`server-page-data-access-ratchet`'s own header says it: *"the comment is not the check; moving the
code somewhere a test can drive it is."* The move happened. The drive never followed.

**Proposal** — one behavioural test, two cases: a Supabase error → `{target: null, ok: false}`; a
genuine miss → `{target: null, ok: true}`. Keep the source guard; it catches the page-side
regression the unit test can't see. Then sweep for siblings: extractions done *for* testability
whose behavioural test was never written.

Two other 0%-coverage `lib/` modules, for completeness, both lower stakes:
`lib/chains/flow/cadence/purchase-moment-flow-wallet.ts` (74 lines, Cadence-write, shelved) and
`lib/chains/flow/cadence/wallet-preflight.ts` (218 lines, no test reference at all).

---

### (3) Branch coverage on the ingest / indexer / backfill family — 96 files at 71.4%

These are the routes that return 202 and fail invisibly. Worst by branch %, min 40 branches:

| route | stmt % | branch % | uncovered branches |
|---|---|---|---|
| `cron/pinnacle-listings-reconcile` | **40.7** | **28.6** | 30 |
| `cron/sync-sales-seller-recovery-dune` | 87.5 | 58.2 | 38 |
| `sales-indexer` | 83.4 | 59.3 | **118** |
| `cron/sync-sales-ingest-dune` | 88.3 | 59.5 | 47 |
| `allday-sets` | 78.5 | 60.0 | 78 |
| `fmv-recalc` | 85.8 | 60.0 | **152** |
| `ingest` | 81.5 | 62.1 | **108** |
| `allday-listings-retry` | 89.0 | 62.6 | 55 |

(`bots/discord/register` is the only other route under 55% statements, at 42.5/41.7.)

**Proposal** — this is the cheapest large win, because `__tests__/helpers/route-harness.ts` already
exists and the all-empty `makeSupabaseFixture` drives most GETs to a stable 200. Target the
`after()` bodies' failure arms on the eight routes above. Then **raise the primary gate's branch
threshold specifically** — it carries the most headroom of the four (79.25 vs 78.6) and is the
metric that actually tracks this work.

---

### (4) Edge functions: 10,642 lines in 32 of 38 functions that no test can reach

`edge-deno` (CI) runs `deno check` + an informational `deno lint`. **There is no Deno test run.**
Behavioural coverage exists only for logic extracted into `supabase/functions/_shared`.

- **32 of 38** `index.ts` files import nothing from `_shared` — **10,642 lines**.
- Largest: `compute-topshot-pack-ev/index.ts`, **1,583 lines**, computing the public **+EV badge**
  inline. Already known: `edge-pack-ev-row-source-drift.test.ts` guards five expressions and its
  header states honestly that it *"pins the EXPRESSIONS, not the behaviour… a change that keeps
  these five lines while altering what feeds them passes."*
- Next by size with zero extraction: `sales-serial-backfill` (566), `ingest-allday-pack-opens`
  (523), `ingest-topshot-pack-opens-history` (425), `pinnacle-owner-discovery` (407),
  `topshot-stub-resolver` (404), `hybrid-custody-events` (399).

**And a cheap structural fix worth taking first:** `supabase/functions/_shared` — **2,615 lines
across 29 modules, every one referenced by a test** — is in **no gate's `include`**. It is tested
but **unmeasured**, so nothing ratchets it and the next `_shared` module can land untested in
silence. Add `supabase/functions/_shared/**/*.ts` to the primary gate's include and re-seat the
four thresholds in the same commit.

---

### (5) DB layer: 105 of 168 unscheduled writer functions have no SQL pin; 22 of them delete

`supabase/tests/*.sql` holds **174** pins. Measured against the live DB:

- **215** writer functions in `public` (INSERT / UPDATE … SET / DELETE / TRUNCATE in `prosrc`).
- **46** are named directly by a `cron.job.command`; **169** are not.
- Of those 169 unscheduled writers, **63 are named by a pin file, 105 are not**.
- **22 of the 105 delete or truncate.** The repo's own rule is *deleters first* — over-deletion
  produces an ABSENCE, not an error.

⚠ **Highest-stakes single item: `trim_recent_searches`.** It DELETEs, `anon` **and**
`authenticated` hold EXECUTE on it, it has **zero in-DB callers**, and `grep -rn trim_recent_searches`
across all `.ts`/`.tsx`/`.sql` in the repo returns **nothing**. An anon-executable deleter with no
caller and no pin should be pinned or revoked — decide which, but not neither.

Second cluster: the ten `purge_old_*` retention deleters, reached through `prune_log_tables`, which
`app/api/cron/prune-logs/route.ts` calls and `api-cron-prune-logs.test.ts` covers. ⚠ **That test
fixtures the RPC** — it proves the route calls it, not that the cutoff arithmetic deletes the right
rows. Retention cutoffs are the documented `<` vs `<=` boundary class; `NOW()` is
transaction-stable, so insert a row at exactly `now() - interval '<retention>'`.

⚠ Predicate caveat, stated so nobody re-derives it wrong: "unscheduled" here means *not named
directly by a `cron.job.command`*. Some are reached through a scheduled wrapper or an API route —
`prune_log_tables` is exactly that. It is a ranking heuristic, not a liveness claim.

---

### (6) The component gate's `include` is a curated list, and it has drifted

`vitest.components.config.ts` lists **18 explicit subtrees**. Four subtrees on disk match none of
them and are invisible to the gate **by construction** — the repo's own documented guard failure,
in the gate's own config:

| subtree | files | lines | test references |
|---|---|---|---|
| `components/play` (`PlayHub.tsx`) | 1 | 171 | **0** |
| `components/legal` (`FmvDisclaimer.tsx`) | 1 | 103 | **0** |
| `components/visual` | 2 | 96 | 1 |
| `components/ui` (`LoadingState.tsx`) | 1 | 27 | **0** |

**Proposal** — replace the 18-entry list with `components/**/*.tsx` (plus the existing `app/**`
entries) and re-seat thresholds in the same commit. A tree walk over a curated list is this repo's
stated preference, and ~397 lines is a small enough re-seat to do safely.

---

### (7) Server `page.tsx` — 111 files / 17,405 lines, measured by no gate

Only **10** are referenced by any test. Two clarifications on the live state, because the prose in
`testing-and-ci.md` is older than the workstream:

- **The client-page conversion is genuinely done.** 8 `"use client"` `page.tsx` remain; 3 are in the
  component gate's include, 4 are 20–43 line shells delegating to a gated `*Client.tsx`, and the
  last is `app/rewards/page.tsx` (1,243 lines) behind an unconditional `notFound()`.
- **Direct DB access is well handled.** `server-page-data-access-ratchet` is at BUDGET 8 with
  NON_PAGE_BUDGET at a ban-at-zero.

The remaining gap is neither of those: it is the **render layer** — the code deciding whether a
failed fetcher renders as an error or as "no results". 23 server pages consume a fetcher or call
`fetch()` directly; the largest are `[collection]/pack/[id]` (734 lines), `insights/page.tsx`
(586), `share/[wallet]` (544), `analytics/page.tsx` (507).

**Proposal** — do not try to gate 111 pages. Extend `server-pages-error-vs-absent-guard.test.ts`
(today: 2 pages) across those 23, asserting the property it already asserts well: **the error
branch precedes the empty branch**. `[collection]/market`'s `loading : error : empty` ladder is
named in the docs as the shape to copy. This is a source guard, with the boundary that implies —
but it is the right instrument for a layer no runner executes.

---

### (8) Smaller, still worth logging

- **Worst component files by uncovered branches** (all inside the gate): `CollectionTabClient` 142
  ubr / 75.6% br · `DashboardClient` 113 / 82.1 · `SniperClient` 105 / 80.2 ·
  `CollectionAnalyticsClient` 102 / 80.8 · `ErrorTriageClient` 68 / **64.0**. Under 70% statements:
  `PopularOnCollection` **31.5%** (its fetchers were just extracted to `lib/`; the render was never
  driven — same shape as item 2), `PackShareButton` 44.4%, `BetaActivityClient` 65.3%.
- **Worst workers files**: `sports-proxy/index.ts` 66.3% st / **44.1% br** (115 uncovered
  statements) and `rpc-mcp-proxy/index.ts` 71.7 / **49.0**. The workers gate has the lowest branch
  threshold of the three (72.1) and these two are most of the reason.
  ⚠ `infrastructure/spork-proxy-worker/index.ts` (75 lines) is outside the workers gate's
  `workers/**` include entirely, and differs from `workers/spork-proxy/index.ts`.
- **E2E is a monitor, not a gate.** `e2e-smoke.yml` runs every 6h + dispatch, never on
  `pull_request`, over **55 public paths**. It touches **zero signed-in surfaces** — dashboard,
  profile, alerts, packs — which is where the worst honesty sub-class lives (a false claim about
  the reader's *own account*, the one that makes them redo finished work).
- **`scripts/`** — 78 files / 18,874 lines in no coverage include; 8 referenced by tests. Mostly
  ops one-offs, but `check-tree-corruption.mjs` is a blocking CI guard with **no test of its own**
  (its CI step does assert a non-vacuous inspected-file count, which is the important half).
- **`check-migration-parity.mjs`** runs in `migration-parity.yml` as `… | tee parity.log || true`
  and only emits `::warning::`. That is a deliberate, documented choice — noted here as a candidate
  to escalate, not as a defect.

---

## 3. What I checked and did NOT find

Recorded so nobody re-runs it.

- **Vacuous negative-claim assertions (the "sixth shape").** Mechanically swept all 1312 test files
  for `it()` titles carrying a negative or transformation claim (`without`, `never`, `does not`,
  `rather than`, `at or below`, `omits`, `withholds`) whose body holds ≤1 `expect(`. Twelve cases
  have **zero** `expect(` — every one resolves to a `findByText`/`findBy*` assertion, which throws
  on absence. **No vacuous instance surfaced.** That class looks genuinely under control.
- **Route breadth.** 456/456 `route.ts` referenced. Nothing to add.
- **Client-page conversion workstream.** Done, per item 7.

---

## Suggested order

1. `lib/edition/legacy-redirect.ts` behavioural test — one file, closes a live SEO/404 honesty gap.
2. Add `supabase/functions/_shared/**` to the primary gate's include — one config line + a re-seat.
3. Component-gate include → tree walk — one config change + a re-seat.
4. `trim_recent_searches` — pin it or revoke it.
5. `lib/pipeline/heartbeat.ts` + the `after()` heartbeat ratchet — the largest and most valuable.
6. Branch coverage on the eight named ingest routes; then raise the branch threshold.
7. The 22 unpinned unscheduled deleters, deleters first.
8. `_shared` extraction for the next tier of edge functions, ranked by product stakes.
