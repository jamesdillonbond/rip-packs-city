# Test-coverage analysis — where the remaining risk actually is (2026-08-18 02:30Z / 2026-08-17 19:30 PT)

Requested: "analyze the test coverage of the codebase and propose some areas in which we should
improve our tests." Everything below is **re-derived live in this session**, not quoted from
`docs/reference/testing-and-ci.md` — several numbers in that file are stale and are corrected here.

## ⚠ STATUS — this file is now part register. §1, §2 and §5 are shipped; §3 has its first pin

- **§1 — CLOSED by a CONCURRENT SESSION, not by this one.** Two sessions worked it within the hour;
  see the ✅ block inside §1 for what landed. ⚠ **Recorded because the collision is the lesson:** both
  sessions re-derived the same counts (5 Rule-A / 101 Rule-B), and the one that shipped went further —
  Rule B as a site-wide *ratchet* rather than left insights-only — **and it caught something this file
  got wrong**, that `DashboardAlertsClient` never server-renders. *Server-fetched data* and
  *server-rendered markup* are different things. Duplicated effort, better answer; the ledger is the
  only thing that would have prevented the duplication.
- **§2 — SHIPPED.** `OG_INHERITED` / `TWITTER_INHERITED` exported and spread into **43** inline
  metadata blocks; the named-helpers guard joined by a tree walk
  (`__tests__/metadata-inline-blocks-inherit-root-fields.test.ts`), mutation-tested.
- **§5 — SHIPPED.** The live smoke went **6 → 31** `/insights` entries, with a **bidirectional**
  completeness guard (`__tests__/e2e-smoke-covers-public-insights-boards.test.ts`) so a launch-flag
  flip fails in a sub-second vitest case rather than on the 6-hourly monitor.
- **§3 — TWO pins landed:** `build_deal_alerts_for_subscription` and `dispatch_due_deal_alerts` (the
  preview and sending halves of the alert pipeline), both verified byte-identical to LIVE `prosrc`
  before pinning and each killed by multiple mutations. Pins 180 → 182, DB suite 171 → 174 files.
  **272 substantial functions remain unpinned.** ⚠ The dispatcher's first fixture let **two of five
  mutations survive** — see §3 for both shapes; the assertions were fine, the fixture could not
  distinguish the implementations.
- **§4 is untouched and remains the largest gap.**

⚠ **§0's read of the component gate's margin was too kind and is corrected immediately below.**

> 🔒 **CLAIMED 2026-08-17 ~21:0x PT (Claude Code, interactive) — I am working the component-gate
> NONDETERMINISM (the `functions` coin flip corrected in §0 below), starting with `SniperClient.tsx`.**
> Claiming it here rather than in the ledger because this is where the next session will look, and
> because the two of us just burned a duplicate §2 for want of exactly this line. **§3
> (`dispatch_due_deal_alerts` and the rest of the DB pins) is the other session's lane — I am not
> touching it.** If this claim is more than a few hours old, assume it is stale and take it.

## 0. The three gates, measured today

Ran all three from a fresh `npm ci` on `main` @ `a690b507`.

| gate | live actual (st / br / fn / ln) | threshold in config | margin |
|---|---|---|---|
| primary (`lib/**` + `app/**/route.{ts,tsx}` + `proxy.ts`) | **91.78 / 79.23 / 93.56 / 93.86** | 91.3 / 78.6 / 93.1 / 93.4 | +0.48 / +0.63 / +0.46 / +0.46 |
| components (`vitest.components.config.ts`) | **90.68 / 81.86 / 89.25 / 93.60** | 90.3 / 81.6 / 89.1 / 93.2 | +0.38 / +0.26 / **+0.15** / +0.40 |
| workers (`vitest.workers.config.ts`) | **85.59 / 72.61 / 84.25 / 88.53** | 85.1 / 72.1 / 83.8 / 88.1 | +0.49 / +0.51 / +0.45 / +0.43 |

All three green.

### ⚠ The gates red on code that did not change — CONFIRMED LIVE, then partly fixed

**`c9923296` is a DOCS-ONLY commit and its `unit-tests` job FAILED on `main`**, between two passing
runs of essentially the same code (`272b6ce1` before, `0b112c0f` after). Not a threshold — a **flaky
test**: `component-AdminFeedbackClient.test.tsx:363`, *"does not fire a request per keystroke"*,
`expected 2 to be 1`. It slept **90ms of WALL CLOCK** inside a **300ms** debounce window and asserted
nothing had fired. A `setTimeout` is a floor on the delay, never a ceiling: under runner contention the
sleep itself outlasts the window, the debounce fires, and the count is 2. It blocked the branch for
everyone over a component nobody had touched.

⚠ **A sweep for the expression rather than the file found five siblings, and they are NOT all the same
risk** — recorded so nobody blanket-converts them:

| site | window | verdict |
|---|---|---|
| `component-AdminFeedbackClient.test.tsx:363` | 300ms, slept 90 | **FIXED** — the one that actually reddened `main` |
| `component-CollectionAnalyticsClient.test.tsx:497` | 500ms, slept 120 | **FIXED** — identical shape, latent |
| `component-MarketClient.test.tsx:478` | 350ms, slept 60 | **FIXED** — identical shape, latent |
| `component-DashboardClient.test.tsx:1309` | no window | **FIXED, different defect** — it compared against a baseline it took of itself, so a persisted no-op that had not landed in 40ms satisfied the assertion. Now absolute (`toBe(0)`). |
| `component-CollectionTabClient.test.tsx:801`, `component-AdminFeedbackClient.test.tsx:712` | n/a | **LEFT ALONE** — their claims (no saved wallets ⇒ no prefetch; no token ⇒ no request) are true at any elapsed time, so the sleep is a courtesy, not a premise. |

The three real fixes use fake timers with `act()` around both the keystrokes and the advance.
⚠ **The first fake-timer version was VACUOUS and only the mutation caught it**: without `act()` React
had not yet run the effect that schedules the debounce, so the timer was created *after* the advance
and a `0ms` debounce behaved exactly like a `300ms` one. Every one of the three is now mutation-verified
(window → 0 reds the case).

⚠ **CORRECTION, and the remaining half of this is still open: the component gate's
`functions` number is NOT 0.15pt above its threshold — it is INSIDE THE RUN-TO-RUN NOISE.** Measured
across five runs on two trees (all `EXIT=0`): **3484, 3485, 3486, 3488, 3490 covered of 3910** →
**89.10 / 89.13 / 89.15 / 89.20 / 89.25**, against a threshold of **89.1**. The low sample clears it by
**0.004pt**; **one more uncovered function reds CI on an unchanged tree.** An A/B with the working tree
stashed confirms this predates this pass — baseline measured 89.15 and the changed tree 89.20, the only
per-file move being `SniperClient.tsx` at +2 covered functions, which is itself the jitter. So
`component-tests` is currently a coin flip, and the next person to see it red will read it as their own
regression. ⚠ **The fix is NOT to lower the threshold** (the config's own rule, and the repo has paid
for the compounding version). It is to find the nondeterministic suite.

🔒 **LANE NOTE — the `SniperClient` half is CLAIMED by another session (see the block at the top of
§0), and this pass did NOT touch it.** The four flakes fixed above are a disjoint set
(`AdminFeedbackClient`, `CollectionAnalyticsClient`, `MarketClient`, `DashboardClient`) and were about
the **primary** gate's red on a docs-only commit, not the component gate's `functions` coin flip. The
hypothesis below is handed over, not worked.

**Leading hypothesis, stated as a hypothesis:** `SniperClient.tsx` was the only file whose function
count moved between two runs of the same tree (+2), and it holds a **`setInterval` countdown**
(`app/(collections)/[collection]/sniper/SniperClient.tsx:509`) plus several `setTimeout` callbacks. A
timer callback that fires in a slow run and not a fast one is exactly a ±2-function swing. **Not
measured** — a plausible mechanism is not a measurement, and this one has not been tested. The check is
cheap: run the SniperClient suite alone under fake timers and see whether the file's function count
stops moving.

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

> ✅ **SHIPPED 2026-08-17 (Claude Code, interactive) — §1 is CLOSED. Rule A is now a site-wide ban,
> Rule B a site-wide ratchet at 101, and the guard walks `app/` + `components/` instead of a
> two-directory `ROOTS` list.** Counts re-derived independently before acting and they matched:
> **5 Rule-A, 101 Rule-B across 42 files.**
>
> ⚠ **THIS SECTION'S SEVERITY READ WAS WRONG ON ONE SITE — do not act on the table below as written.**
> It calls `DashboardAlertsClient.tsx:297` *"server-fetched, signed-in surface"* and groups it with
> Panini as one of *"the first two … the dangerous shape."* Measured: `alerts` is
> `useState<Alert[] | null>(null)` filled by a client `fetch`, and the table is gated on
> `alerts && alerts.length > 0` — **it never server-renders.** *Server-fetched data* and
> *server-rendered markup* are different things, and only the second can mismatch. **Exactly ONE of
> the five was a live defect** (Panini), and the section's own hedge on the other three — *"probably
> inert … stated as probably, not verified"* — turned out to cover four, not three.
>
> ✅ **And the one real defect was worse than §1 says.** `PANINI_NEWS` is a **module constant** of
> date-only ISO strings, parsed as UTC midnight: `2026-03-30` renders **`Mar 30` in UTC, `Mar 29` in
> both US zones**. So it was not only React #418 — it **showed every US reader the wrong date on a
> public page**. Fixed with `timeZone: "UTC"`.
>
> ⛔ **The proposal's "add `timeZone: \"UTC\"`… to the 5 sites" would have been a REGRESSION on four
> of them.** They are post-mount clocks; pinning a "last updated" clock to UTC shows the viewer UTC.
> They carry an inline `hydration-safe: <reason>` marker instead — co-located and required to state a
> reason, deliberately not the central allowlist this repo has watched drift both ways.

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

**SHIPPED.** `lib/seo.ts`'s own instruction — *"spread these into every block rather than restating
the literals"* — had only ever been applied to its three helpers, so `OG_INHERITED` /
`TWITTER_INHERITED` are now **exported** and spread into all **43** deficient blocks (the sweep also
caught 5 `openGraph` blocks missing `locale`/`siteName`/`type`, beyond the 38 twitter ones).
`__tests__/metadata-inline-blocks-inherit-root-fields.test.ts` walks the tree, derives the demanded
fields from those constants, and separately asserts the constants match `rootMetadata` — so adding a
root field widens the ban for free. The R10 helper guard stays; this joins it rather than replacing it.

⚠ **Its own extractor had a bug my fixture caught: the brace matcher was not string-aware**, so a `}`
inside a quoted `alt:` closed the block early and reported fields that were present. A FALSE POSITIVE
is the expensive direction on a guard — it reds CI on correct code, and the next person weakens the
guard to get green.

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

**FIRST PIN SHIPPED.** `supabase/tests/build_deal_alerts_for_subscription.sql`, registered in the
drift guard (pins 180 → 181, DB suite 171 → 172 files, all green). It pins the two defects the
2026-08-16 migration fixed and the asymmetry between them: **price-only routing** (a `max_price` with
`min_discount = 0` must read `edition_current_ask`, the raw ask universe, and see a row with NO
`fmv_usd` — the pre-fix code read the deals board, so a saved $0.60 alert intersected an empty set for
weeks), **set-name containment** ("Archive" matches "Archive Set"), and **player-name exactness**
("Damian" must NOT match "Damian Lillard"). Also pinned: the two pools are mutually exclusive per
subscription, and `deals_count` sums both passes.

⚠ **Verified against LIVE, not just against the migration.** The migration's body is byte-identical to
production `prosrc` (md5 `f17cfe05e4ab8d88e05fd56f7ce021c8`, 8,943 chars) — a pin against a stale
migration would pin something production does not run, and CLAUDE.md records that some objects were
applied by MCP and never committed. **Three mutations kill it**: reverting the price pool to the deals
board, reverting set-names to equality, and loosening player-names to `LIKE`.

⚠ **`rebuild_flowty_loans` CANNOT be pinned today** — it has **no committed migration**, so there is no
verbatim source for the drift guard to compare against. That is a prerequisite, not an oversight to
work around: dumping live `prosrc` into a test file would pin whatever is deployed with nothing
asserting the repo agrees.

**Next, in order:** `dispatch_due_deal_alerts` (13,203 chars, the sending half of the same pipeline,
same migration file), then `get_collection_stats` and `get_wallet_pack_summary` (claims about the market
and about the reader's own account), then `rpc_search_catalog`.

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

**SHIPPED, and the sweep found a stale comment doing real damage.** The list is now the hub + **30
boards**. The spec's comment claimed `panini-squeeze` and `candy-mlb` were *"deliberately omitted …
until its flag stays flipped"* — **both flags have been `true` in `lib/launch-flags.ts` since their
launches**, so two live public boards sat outside the only monitor that can see them, protected by a
sentence that read like a decision.

`__tests__/e2e-smoke-covers-public-insights-boards.test.ts` derives the population from
`app/insights/*` + the real `isPublicPath`, and is **bidirectional on purpose**: it also fails if a
GATED board is listed. A one-way check would have gone red in the slowest place — the 6-hourly live
monitor, on a board now 302-ing to `/login` and rendering 0 chars, which is the cry-wolf entry
`smoke.spec.ts` already carries a long warning about. Both directions mutation-tested (delete a board
line; flip `CANDY_MLB_PUBLIC` to `false`).

⚠ **The 23 new entries were added UNPROBED** — this sandbox has no egress to production (the agent
proxy rejects the connect), so the first scheduled run is their validation. Recorded in the spec
itself: if one fails, triage it; do not delete the line.

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
- **`scripts/check-tree-corruption.mjs` has no test.** The other CI guard scripts do.
  ⚠ `find-future-dated-ledger-headings.mjs` was in this list when the file was first written and is
  **already closed** — `57586c58` landed `__tests__/find-future-dated-ledger-headings.test.ts` while
  this pass was running. Left visible rather than deleted: a finding list is a dated sample too, and
  this one aged in under an hour.

---

## What is left, in order

1. ~~**The component gate's `functions` jitter (§0).**~~ ✅ **CLOSED the same night by the session that
   claimed the lane — and the suspect named here (`SniperClient.tsx`) was REFUTED on measurement.** It
   was `CollectionTabClient`, whose Load More case was passing *without exercising Load More*; the
   coverage wobble was the symptom of an intermittently-vacuous assertion, not of a noisy gate. ⚠ Not
   a claim that the gate is now deterministic: the 3484/3485 low end did not reproduce in that
   session's six runs, so one source was removed, not proven to be the only one.
2. **§4 edge-fn cursor extraction** — the largest gap, and the only one that is a real project. Start
   with the two `event_cursor` ingesters: a cursor that advances past a failed write is silent
   permanent loss, and nothing today can catch it.
3. **§3, the remaining 272 pins.** `dispatch_due_deal_alerts` is done; next are
   `get_collection_stats` and `get_wallet_pack_summary` (a claim about the market and one about the
   reader's own account), then `rpc_search_catalog`. ⚠ `rebuild_flowty_loans` is BLOCKED, not next: it
   has no committed migration, so there is no verbatim source for the drift guard to compare against.
4. **§6 smaller items** — `app/global-error.tsx` (zero tests, neither gate),
   `components/entity/PopularOnCollection.tsx` (29/29/7.7, and outside the server-page ratchet),
   `workers/sports-proxy` (44.53 br, and the subject of the top open item).

Deliberately **not** proposed, then or now: raising any threshold. Two of the three gates sit in their
designed band; the third's problem is noise, not level, and lowering it is what the config forbids.
