# Test-coverage analysis — where the remaining risk actually is (2026-08-18 02:30Z / 2026-08-17 19:30 PT)

Requested: "analyze the test coverage of the codebase and propose some areas in which we should
improve our tests." Everything below is **re-derived live in this session**, not quoted from
`docs/reference/testing-and-ci.md` — several numbers in that file are stale and are corrected here.

## 0. The three gates, measured today

Ran all three from a fresh `npm ci` on `main` @ `a690b507`.

| gate | live actual (st / br / fn / ln) | threshold in config | margin |
|---|---|---|---|
| primary (`lib/**` + `app/**/route.{ts,tsx}` + `proxy.ts`) | **91.78 / 79.23 / 93.56 / 93.86** | 91.3 / 78.6 / 93.1 / 93.4 | +0.48 / +0.63 / +0.46 / +0.46 |
| components (`vitest.components.config.ts`) | **90.68 / 81.86 / 89.25 / 93.60** | 90.3 / 81.6 / 89.1 / 93.2 | +0.38 / +0.26 / **+0.15** / +0.40 |
| workers (`vitest.workers.config.ts`) | **85.59 / 72.61 / 84.25 / 88.53** | 85.1 / 72.1 / 83.8 / 88.1 | +0.49 / +0.51 / +0.45 / +0.43 |

All three green. The component gate's **functions** margin is 0.15pt — the binding constraint, and
exactly the dimension `testing-and-ci.md` warns a partly-tested `*Client.tsx` conversion hits hardest.

⚠ **Corrections to `docs/reference/testing-and-ci.md` found while re-deriving:**
- It says server `page.tsx` is "48,325 LOC" and client `page.tsx` "27,016 LOC / 33 files". Live today:
  **119 `page.tsx` totalling 20,351 lines**, of which **4 are `"use client"` (2,972 lines)**. The
  conversion programme finished; the ~75k figure is a landing-day number, not a current one.
- ⚠ **`.gitignore:117-121` records the invariant *"the two gates must run into SEPARATE
  reportsDirectory dirs or they corrupt each other's `coverage/.tmp`"* — and **no config sets
  `reportsDirectory` at all**, so the `/coverage-*` ignore line guards directories nothing creates.
  Hit empirically in this session: two gates run concurrently and one dies with *"Something removed
  the coverage directory"*. CI is safe (separate jobs); a local parallel run is not. A documented
  invariant with no implementation and no test is the same shape as an unenforced guard.
  One-line fix: distinct `coverage.reportsDirectory` per config.

**Breadth is genuinely not the problem** (re-derived): 501/501 `route.{ts,tsx}` and 288/293 `lib/`
modules are referenced by some test; 151/156 components; 24/24 workers. Only **2 files sit at 0%** in
the primary gate (`lib/edition/legacy-redirect.ts`, `lib/chains/flow/cadence/purchase-moment-flow-wallet.ts`).
Of 1,308 test files, **0 have no `expect()`** and only **2** assert exclusively weak matchers. The
suite is in good shape. What follows is about what the gates cannot see, ranked.

---

## 1. The hydration guard is at population ZERO inside its own roots — and blind to 5 live instances outside them

`__tests__/insights-client-dates-are-hydration-safe-guard.test.ts` has `const ROOTS = ["app/insights",
"components/insights"]`. Re-running its own `findUnsafeLocaleCalls` rules over **all** of `app/` +
`components/`:

- **inside** the guard's roots: **0 violations** (the workstream succeeded)
- **outside** them: **45 client files, 106 call sites** — of which **5 are Rule A** (a date/time
  rendered in the *runtime timezone*, the precise shape of the two shipped React #418 incidents) and
  101 are Rule B (runtime locale).

The 5 Rule-A sites:

| file | what it renders |
|---|---|
| `app/(collections)/panini-blockchain/overview/PaniniOverviewClient.tsx:321` | `new Date(item.date).toLocaleDateString("en-US", …)` — a **server-fetched** date in a hydrated list |
| `app/dashboard/alerts/DashboardAlertsClient.tsx:297` | `new Date(a.last_triggered_at).toLocaleDateString("en-US")` — server-fetched, signed-in surface |
| `app/(collections)/disney-pinnacle/sniper/PinnacleSniperClient.tsx:396` | `toLocaleTimeString([], …)` on `lastRefreshed` |
| `components/sniper/SniperStatsBar.tsx:33` | `toLocaleTimeString([], …)` on `lastRefreshed` |
| `app/admin/analytics/AdminAnalyticsClient.tsx:259` | `lastFetched.toLocaleTimeString("en-US")` |

The first two are the dangerous shape (a value that exists at SSR time and can cross a day boundary
before hydration). The last three render client-set state and are probably inert — **stated as
probably, not verified**; the point is that nothing distinguishes them today.

This is the repo's own documented failure mode — *"ask what a passing guard is structurally SILENT
about; prefer a tree walk over a curated list"* — reproduced exactly. ⚠ **And the guard reads green
either way**, because it is green on a population it drove to zero.

**Proposal.** Widen `ROOTS` to `["app", "components"]` for **Rule A only** and make it a *ban at zero*
after fixing the 5 sites (add `timeZone: "UTC"`, or move the format into a shared helper). Leave Rule B
on a **ratchet** at 101 — 101 sites is a ratchet population, not a ban population, and this repo has
already learned that a ban shipping a 40-entry allowlist is theatre. Cost: hours, not days.

## 2. The OG shallow-merge guard tests three helpers; 38 inline `twitter:` blocks bypass them

`lib/seo.ts:58-65` states the contract: the root sets `twitter.site` **and** `twitter.creator`, and
*"every page that does not define its own twitter block unfurled with no attribution at all."*
`__tests__/seo-shared-helpers-inherit-og-twitter.test.ts` pins that for the three shared helpers —
`pageMetadata`, `collectionLayoutMetadata`, `buildMeta` — by **naming them**, not by walking the tree.

Live sweep of every `app/**` file exporting `metadata`/`generateMetadata` with an **inline**
`twitter:` object literal: **38 blocks omit `site:`**, so Next's top-level-key replacement drops the
root's `site: '@RipPacksCity'`. **31 of the 38 are the `/insights/*` board layouts** — the surface this
repo calls its most shareable — e.g. `app/insights/squeeze/layout.tsx` sets `creator` and no `site`.
5 blocks omit `creator` too (`app/blog/*`, `app/pinnacle/moment/[id]`, `app/(collections)/[collection]/pack/[id]`,
`app/nba/fast-break/layout.tsx`).

⚠ **Not verified against a live unfurl** — this is derived from the source plus the merge semantics
`lib/seo.ts` itself documents. Confirm one board with the X card validator before doing the sweep.

**Proposal.** Replace the 3-case guard with a **tree walk** over `app/**` that extracts every inline
`openGraph`/`twitter` literal and asserts it carries the root's fields (derive the required field list
from `rootMetadata`, as the current guard already does, so adding a root field widens the guard for
free). Ban at zero once the 38 are fixed — the fix is one line per file.

## 3. 274 of 397 substantial DB functions have no SQL invariant pin

`__tests__/db-invariants-drift-guard.test.ts` carries **180 pins over 179 distinct functions** (matches
the doc). Live: `public` holds **657 functions (543 SECURITY DEFINER)**; **397 have `prosrc >= 800
chars`**. Of those 397, **123 are pinned and 274 are not**.

The nine largest **unpinned** functions, with what they do:

| function | prosrc | why it matters |
|---|---|---|
| `analytics_smoke_run` | 21,156 | the smoke gate's own body — a monitor with no test |
| `dispatch_due_deal_alerts` | 13,203 | **sends alerts to users**; a false positive is an outbound email |
| `rpc_trust_health_precompute_refresh` | 13,009 | drives the trust board |
| `get_collection_stats` | 12,558 | every collection page's headline numbers |
| `rebuild_flowty_loans` | 11,442 | rewrites a whole table |
| `get_pipeline_alerts_core` | 11,383 | the pipeline sentinel's core |
| `build_deal_alerts_for_subscription` | 8,943 | alert construction |
| `rpc_search_catalog` | 8,476 | site search |
| `get_wallet_pack_summary` | 9,325 | a claim about the reader's own account |

⚠ **`rebuild_flowty_loans` and `get_pipeline_alerts_core` are referenced by ZERO tests of any kind.**
The other seven have vitest hits, but those are route tests that **stub the RPC by name** — they pin
the call, never the SQL body. That is the same "mirror green, deployed copy drifted" hole the edge-fn
drift guards exist to close, on a much larger surface.

**Proposal.** Pin, in this order: `dispatch_due_deal_alerts` + `build_deal_alerts_for_subscription`
(an alert's output is silence, so its errors are unfalsifiable — the repo's own worst sub-class),
then `get_collection_stats` and `get_wallet_pack_summary` (claims about the market and about the
reader's own account), then `rpc_search_catalog`. Five pins ≈ five files, and the harness already
exists (`supabase/tests/_helpers.sql`, self-contained + `ROLLBACK`).

## 4. 13,653 LOC of Deno edge-function bodies are type-checked and never executed

`supabase/functions/_shared/` (29 modules, 2,615 LOC) is well covered — 29 `edge-*.test.ts` files,
plus equality drift guards. But the 37 `index.ts` bodies total **13,653 LOC**, and **31 of 37 import
nothing from `_shared`**. The `edge-deno` CI job runs `deno check` + `deno lint` (informational) —
there is no Deno test step, so none of that code is ever executed by CI.

**46 write sites (`.insert` / `.upsert` / `.delete`) live in that unexecuted code**, including
`compute-topshot-pack-ev` (1,584 LOC, 0 shared imports, 4 writes) and the pack-opens ingesters. These
are precisely the paths whose failure modes CLAUDE.md documents as production incidents: the
all-or-nothing batch insert, the cursor that advances past unwritten rows, `rows_written = 0` as a
null instrument.

**Controls run, and both came back clean** — recorded so nobody re-derives them: the fabricated-divisor
shape (`x / (y || 1)`) has **0 sites** in `supabase/functions` (2 in `scripts/flow-backfill.ts`), and
the 10 `count ?? 0` sites there are all GraphQL node counts, not supabase counts. So the *known*
defect shapes are absent; the risk is the untested orchestration, not a known-bad idiom.

**Proposal.** Do not try to test 13.6k LOC. Extract the **orchestration** — cursor advance, batch
chunking, retry/backoff, and the `pipeline_runs` outcome record — into `_shared` modules and unit-test
those, starting with the two ingesters that maintain `event_cursor`
(`ingest-allday-pack-opens`, `ingest-topshot-pack-opens-history`): a cursor that advances on a failed
write is silent permanent data loss, and nothing today can catch it.

## 5. The live-browser smoke covers 30 URLs; 25 of the 30 `/insights` boards are not among them

`e2e/smoke.spec.ts` smokes **30 paths** — every collection tab, `/`, `/pricing`, and the `/insights`
hub plus **5 boards** (`/deals`, `/market`, `/set-completers`, `/squeeze`, `/top-sales`). `app/insights/`
holds **30 board pages** beside that hub. It runs on a 6-hourly schedule against production, never pre-merge.

`e2e/healthy-page.ts` is the only detector for two documented board-specific failure classes: the
200-but-blank streaming shell, and React #418 (unreachable in vitest by construction — both sides
render in one UTC process). Both incidents on record were on `/insights` boards
(`first-mint`, `top-sales`) — **and 25 of those boards are outside the sweep.**

**Proposal.** Extend the smoke list to all 30 `/insights` boards (they are anonymous, so no auth
plumbing). Cheap, and it also covers the "a *slow* board errors nowhere and fails the whole production
build" class that `insights-server-pages-bound-their-reads` is a ban for.

## 6. Smaller, cheap items

- **`app/global-error.tsx`** (58 LOC) — the app's last-resort error boundary. **Referenced by zero
  tests, measured by neither gate.** An untested error boundary is the guard-fails-open shape.
- **56 of 60 `layout.tsx`** are referenced by no test; 12 export `generateMetadata`, 10 call
  `notFound()`/`redirect()`. They are in neither gate's `include`.
- **`components/entity/PopularOnCollection.tsx`** — worst file in the component gate at
  **29.03 st / 29.41 br / 7.69 fn**. It is an async **server** component doing its own
  `sb.from("editions")` reads (lines 81-214 uncovered), so the jsdom harness can only reach its pure
  helpers. It is also invisible to `server-page-data-access-ratchet` (which walks `page.tsx` only).
  ⚠ That blind spot is **small — 3 files total** (`PopularOnCollection.tsx`,
  `app/moment/[id]/layout.tsx`, `app/auth/confirm/AuthConfirmClient.tsx`), so widening the ratchet is
  a 3-file conversion, not a programme.
- **`workers/sports-proxy/index.ts` is the worst-covered file in the workers gate — 67.15 st /
  44.53 br / 61.11 fn.** It is also the subject of the repo's highest-value open item (the 403). Its
  retry / fallback / error branches are the least-tested code in the gate, which is an awkward place
  to be while diagnosing an upstream failure. `workers/rpc-mcp-proxy/index.ts` is next
  (71.67 / 49.03 / 65.38).
- **Lowest branch cluster in the primary gate is the ingest family** — `sales-indexer` 59.31 br,
  `ufc-sales-indexer` 65.6, `topshot-listing-cache` 65, `listings-indexer` 66.46, `offers-indexer`
  68.71. CLAUDE.md already records the sales indexers as a five-way copy-paste family; their *error*
  branches are the untested half.
- **`scripts/check-tree-corruption.mjs` and `scripts/find-future-dated-ledger-headings.mjs` have no
  test.** The other five CI guard scripts do. The second is a day old and is a ban at zero, so it is
  currently unfalsifiable — the repo's own rule is *"before relying on a watcher, prove it can see a
  FAILURE."* (Its author did prove it, on a poisoned fixture, but by hand — the proof is not committed.)

---

## Suggested order

1. **§1 Rule-A hydration widening** — 5 sites, closes a guard that is silent by construction on the
   surfaces where the class actually shipped.
2. **§2 OG tree walk** — one line per file, restores the X byline on 31 public boards.
3. **§5 insights smoke** — a list edit; buys detection on 25 boards.
4. **§3 five DB pins** — highest-consequence untested logic in the stack (an alert dispatcher).
5. **§4 edge-fn cursor extraction** — the largest gap, and the only one that is a real project.

Deliberately **not** proposed: raising any threshold. All three gates sit in their designed 0.15–0.6pt
band, and the component gate's functions margin is thin enough that a partial `*Client.tsx` conversion
would red it.
