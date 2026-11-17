# Rip Packs City — Project Health Report

**Date:** 2026-07-27
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Cross-session Safety §, Testing & CI §, Recent Sessions § — current through the 2026-07-26 Claude-Code entry), `docs/overnight/metrics-latest.json` (captured **2026-07-26T08:05:00Z**), `docs/overnight/ledger.md` (563 entries), `docs/overnight/focus.md` (stale, dated 2026-06-24), `docs/overnight/inbox/` (0 pending — drained), plus a first-hand `git log` / `TODO|FIXME|HACK|XXX` scan and `wc -l` / file-existence verification of the source tree.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#17`), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-07-20.md` (7 days ago). This regeneration mirrors its structure. `_2026-07-13.md`, `_2026-07-06.md`, `_2026-06-29.md`, `_2026-06-22.md`, `_2026-06-15.md`, `_2026-06-08.md`, `_2026-06-03.md`, `_2026-06-01.md`, `_2026-05-30.md`, `_2026-05-25.md`, and `_2026-05-22.md` are also present in `docs/health/`.

> **Tooling note.** The Cowork bash/git sandbox provisioned cleanly this run, so this report has a **real `git log`**: **295 commits since 2026-07-20**, **620 files changed (+54,778 / −6,109)**. Line counts are `wc -l`, existence checks are `ls`/`find`, and the TODO scan is a full `ripgrep`. Only DB-side facts are second-hand (from `metrics-latest.json`, captured 2026-07-26T08:05Z — one day old).

> **Report location stays clean.** The repo root holds **0** `PROJECT_HEALTH_*` files; all thirteen reports (this one included) live in `docs/health/`. This is written there, per the brief.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what the autonomous passes shipped/queued/declined. This doc reorganizes both for triage and adds an in-code TODO inventory neither tracks. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-07-20 — a heavy correctness-and-intelligence week, on top of a now-week-old public launch that still has no audience.** 295 commits across five *active* days (the app was closed 07-22 → 07-24, so no commits landed then; peak: **177 on 07-25**). Six stories: **(1) TWO flagship intelligence capabilities shipped.** (a) The **multi-factor pooled special-serial FMV model** (07-26) — a pooled hedonic ridge regression fit offline, applied at read time as a per-edition power law, now LIVE on *every* serial-estimate surface (board, moment, wallet, trophy, sniper). Validated out-of-sample ~16% better median-APE than the incumbent. This is the crown-jewel serial estimator the June handoffs had gated on sales-completeness. (b) **Candy chain-two productization** (07-24) — the "zero price signal" blocker from last week is **gone**: Candy is now printing ~53 sales/24h, FMV is computed by the standard engine (46/125 editions priced, all LOW-confidence and honest about it), an **ask feed** was built (`candy_listings` + indexer), and the **first gated public board `/insights/candy-mlb`** shipped with 10 supporting views — all anon/authenticated SELECT-**revoked**. **(2) A P0 and multiple silent-data-loss bugs killed.** A **P0 fabricated pack EV** (a $4.99 Pinnacle pack publishing $2,651 gross EV — a 531× ratio) killed at the read layer; a **legacy 2-column wmc unique index silently discarding whole upsert chunks while `pipeline_runs` reported 0 failures** across 3,497 runs; the **57014 retry AMPLIFIER** that tripled DB load on the busiest surface (edition pages, 51% of collection views); and the **23505 batch data-loss class eradicated across all 5 forward sales indexers**. **(3) Test coverage jumped again and grew a 7th CI gate.** The vitest ratchet went **75.5/60.6/80.9/78.0 → 87.3/72.3/90.3/89.85** (live actual ~87.8/72.8/90.8/90.4) — line coverage crossed **90%**. A **NEW component-coverage CI gate** (`vitest.components.config.ts` + a blocking `component-tests` job) closed the biggest measurement blind spot; DB-invariant pins went **12 → 22** (23 `supabase/tests/*.sql` files); test files **751 → 880**. **(4) In-code debt collapsed to essentially one cluster: 34 → 6 real markers (−28).** The **18 chain-rename shims were DELETED** (07-25, Trevor-authorized override of the chain-two gate) — ending the report's largest standing TODO cluster (§5a). Trade Hub's cancel TODO, the lock-roi calibration TODO, and the pinnacle-wallet offer TODO all resolved. Only the **6 Trade Hub `fcl-submit.ts` stubs** remain. **(5) DB reversed direction again — 10,054 → 11,109 MB (+1,055), back over 11 GB.** IOPS saturation on the Micro instance was the operational theme of the week (the retry amplifier, three cron-collision staggers, a pg_cron worker-startup-convergence stagger). **(6) Traction is still flat and now the clear headline concern.** The front door has been open a full week (self-serve signup since 07-20) and the reading is **20 users, 0 new signups, 0 WAU.** Demand — not measurement, not features, not correctness — is the one number that decides everything.

> **Overnight reality — GREEN and un-blocked.** The 07-26 genuine-overnight pass (01:03 PDT, no skew, push available, no FREEZE) shipped 1 (a DB-only pg_cron convergence stagger, independent-subagent PASS 4/4) and ran a post-ship watch over the ~25-commit 07-25/26 interactive wave — **ALL PASS, 0 reverts.** Health at the last capture: security **0/0/0/0**, trust **20 metrics / 0 breaches**, sentinel TS-UUID 48h **0**, `impossible_parallel` **0**, pg_cron failures **[]**, Sentry **0 unresolved**, `stalled_pipelines []`. The one HIGH pipeline alert (AllDay unmapped 45,554 open, +3,589/day) is a **known, carried, off-limits** resolver-throughput item — expected residue of a *succeeding* backfill, not a regression.

> **Traction reality — a full week public, still near-zero.** Last week's reframe ("measurement is done; the gap is demand") is now confirmed by a second data point: **20 users, 0 new signups since the 07-20 front-door open, funnel wired and firing.** Nothing about the launch machinery is broken — the site is public, instrumented, and idle. **Cost/storage reversed AGAIN:** DB is **11,109 MB, UP ~1,055 MB** from last week's 10,054 (which was itself the first-ever weekly decline). The instance crossed back over 11 GB; on an IOPS-constrained Micro instance the disk pressure is the binding operational constraint, and it drove most of this week's ops work.

> **Platform context (unchanged from last week).** **(1) Flowty** frontend shut but API ALIVE and feeding live ingest — teardown premise still obsolete. **(2) NFL All Day** primary pack sales ended; secondary-market only. **(3) UFC Strike** Flow market frozen. **(4) Candy / Solana** — discovery complete, data ingested, **price signal now arrived**, first gated board live; `candy_mlb` stays `is_active=false` pending Trevor's go-live call. **(5) Panini** runner LIVE on a residential box; public surface built + staged behind one `proxy.ts` line; blocker remains **editorial**. **(6) Expansions are readiness-gated, not sequence-gated** — the old "one chain at a time, Candy-first" rule is retired.

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md` — **563 entries**, `inbox/` — **0 pending / drained**, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` halts all autonomous shipping — **verified absent this run = no freeze active.** **Check `docs/overnight/ledger.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#17** | Unchanged in `CLAUDE.md`. `#3` is still double-assigned — "Flowty event indexer" (resolved) + "Trade Hub" (shelved). See §9. |
| Known issues — resolved | 10 | #2, #3 (Flowty indexer), #4, #5, #6, #7, #8, #13, #15, #16 (+ the fmv-recalc silent stall) — see §6 / §9 |
| Known issues — open / partial | **6** | #0, #10, #11, #12, #14, #17 — see §3 / §9 |
| Known issues — shelved by decision | 2 | #1 Cart; #3 Trade Hub (guarded) |
| Known issues — retired | 1 | #9 Storefront audit pipeline |
| Commits this week | **295** | 620 files changed, +54,778 / −6,109. Peak day 07-25 (177). App dormant 07-22 → 07-24. |
| Net-new shipped this week (not numbered) | **10+** | **Pooled special-serial FMV model (NEW, flagship)**; Candy first gated public board `/insights/candy-mlb` + ask feed + 10 gated views (NEW); **component-coverage CI gate** (7th CI job, NEW); P0 pack-EV read-layer guards; legacy-wmc-index data-loss fix; 57014 retry-amplifier fix; 23505 batch-loss eradication across 5 indexers; AllDay unmapped-residue recovery (2,619 sales + self-heal cron); cron-collision + pg_cron-convergence staggers; **18 chain-rename shims DELETED** — §2 |
| Open overnight operational items | **~8 active + ~6 deferred** | Carried: AllDay-unmapped-backlog-growth (HIGH, off-limits); DUNE-DATAPOINT-CAP-402 (both Dune lanes parked); WMC-LOCK-FRESHNESS; MARKET-EDITION-LINK (unbuildable); COMPUTE-LALIGA-PACK-EV schema mismatch; SET-DETAIL-PAGE-POOL-RETRY-GAP (new); refresh-seeded-wallet-stats cost; Vercel/cron-job.org families — see §2.6 |
| Net-new structural workstream | 3 | Multi-chain abstraction (Phases A–F complete; **all 18 shims DELETED 07-25**) + Candy/Solana (**discovery + productization COMPLETE**, first gated board live, go-live is Trevor's call) + Panini (runner LIVE, blocked on an editorial call) (§2.8) |
| Prioritized next actions | **superseded** | `docs/strategy/roadmap-2026-07-18.md` is canonical (post-launch). Old #1 (Flowty) obsolete. Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **6 real / 1 file** (+3 false positives, +1 vendored-contract, +~10 test refs, +~17 resolved-annotation/draft) | **−28 vs last week's 34.** 18 shims deleted, Trade-Hub-cancel resolved, lock-roi + pinnacle-wallet resolved — see §5 / §8 |
| Test files / DB-invariant pins | **880** / **23 SQL files (22 invariants)** | Was 751 / 13. Coverage ratchet 75.5→**87.3** stmts; line coverage crossed 90%. |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** A correctness-and-intelligence week on a launched-but-empty product. Underneath a green operational board, an extraordinary volume of high-quality work landed — two flagship intelligence capabilities (the pooled serial-FMV model and Candy's full productization from "no price signal" to a live gated board), a **P0 fabricated-EV bug** and several **silent-data-loss** classes killed, test coverage pushed past **90% line** with a new component-coverage CI gate, and in-code debt collapsed to a single Trade-Hub cluster after the 18 chain-rename shims were finally deleted. The recurring shape of this week's bugs is worth internalizing: *systems that reported "0 failures" while silently losing data* — a wmc index discarding upsert chunks, a retry loop tripling DB load, batch inserts dropping co-batched new rows. Each was caught by measurement, not alarms. Operationally the platform is GREEN and the overnight tooling is un-blocked; the one binding constraint is **IOPS on the Micro instance** (DB back over 11 GB, +1 GB this week), which drove most of the ops work. But the dominant concern is unchanged and hardening: **demand.** The front door has been open a full week and the reading is 20 users / 0 new signups / 0 WAU — the launch works, nobody is arriving. Descending, concentrated risk: **(1)** traffic/activation post-launch (the only gate that matters — 50+ WAU); **(2)** cost/IOPS on a Micro instance (the disk is the constraint behind the statement-timeout family); **(3)** the Candy go-live editorial call (board built, gated, awaiting Trevor) and the parallel Panini editorial call; **(4)** the carried AllDay-unmapped backlog (HIGH but off-limits/expected). Chain-foundation tails and page polish are secondary.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public un-gate live since 07-17; self-serve signup since 07-20. Funnel wired + firing. Reading: **20 users, 0 new signups, 0 WAU.** The problem is *demand*, not measurement. Gate: **50+ WAU** (§2.1) |
| Data-intelligence — NEW capability | **Pooled special-serial FMV model SHIPPED** (07-26) — ridge-regression hedonic estimator, live on every serial surface, ~16% better out-of-sample. **Candy productized** — price signal arrived, FMV + ask feed + first gated board (§2.3) |
| Data-intelligence correctness | **P0 fabricated pack EV** (531× ratio) killed at read layer; legacy-wmc-index silent upsert loss; **57014 retry amplifier** (3× DB load on the busiest surface); 23505 batch-loss eradicated across 5 indexers; AllDay resolver 4-defect fix (§2.3) |
| Test / quality infrastructure | Ratchet 75.5→**87.3** stmts; **line coverage crossed 90%**. **NEW component-coverage CI gate** (7th CI job); DB pins 12→22; 880 test files. **Never lower thresholds to green a build** (§2.4) |
| Chain expansion (readiness-gated, parallel allowed) | **Candy: productization COMPLETE** — first gated public board `/insights/candy-mlb` + ask feed + 10 anon-revoked views; go-live is a Trevor flag flip. **Panini: runner LIVE**, disclosure structural, bridge built INERT — blocker editorial (§2.8) |
| Cost / operational right-sizing | **DB 11,109 MB — UP ~1,055 MB** (reversed last week's decline; back over 11 GB). **IOPS is the binding constraint** and drove the week's ops work (retry-amplifier, cron staggers, pg_cron convergence stagger) (§2.6) |
| Operational / overnight queue | AllDay-unmapped-backlog (HIGH, off-limits); both Dune lanes parked (DUNE-DATAPOINT-CAP-402); SET-DETAIL-PAGE-POOL-RETRY-GAP (new); LALIGA-PACK-EV schema mismatch; WMC-LOCK-FRESHNESS; MARKET-EDITION-LINK (unbuildable); cron-job.org dropout family (§2.6) |
| Tech debt / refactor | Monoliths flat — collection **1,618** (flat) / sniper **1,705** (+14) / dashboard **2,366** (+6) / analytics **495**. **All 18 chain-rename shims DELETED** — the reorg tail is closed (§3) |
| Page polish | IA reorg carried; entity-section policy + fee-net sniper + Pinnacle serial-FMV wallet landed this week; pack/set/team soft-404 hardening (#17) |
| Stalled / scaffolded features | Trade Hub (#3, shelved + guarded, **now just 6 stub TODOs** after the cancel-callback landed — contract suite 16/16 in CI); Cart (#1, shelved); breaks (dormant); Top Shot in-app bulk-buy (Dapper co-signer wall) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; `badge_editions.low_ask` — **AllDay resolved; Golazos now WIRED this week** (cron shipped 07-25) |

---

## 2. Critical path — start here

Go-live is **done**; `docs/strategy/roadmap-2026-07-18.md` is the canonical forward plan. Phase 1 = prove the product with real users (**the only gate is 50+ WAU**); Phase 2 = cost/latency levers; Phase 3 = durable debt; Phase 4 = chain two, readiness-gated.

### 2.1 Launch + activation — the site is public; demand is the gap — `Severity: High · Effort: Medium (built + measured, needs traffic)`

The un-gate shipped 07-17; self-serve magic-link signup opened 07-20 (`check_email_allowed` flipped from invite-only to allow-by-default, with `deny_list` as the ban hammer). Read-only tabs are anonymous for the 5 published Flow collections; cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **A full week of data now exists, and it's flat.** `metrics-latest.json` (2026-07-26): **20 users, 0 new signups since 07-20, funnel wired + firing.** Nothing is broken — the site is public and instrumented. The absence is traffic.
- **The reframe from last week holds and hardens.** The work is acquisition and retention, not instrumentation. The assets are built and idle: 28 sitemapped `/insights` boards, OG cards on every share surface, a working concierge, live alert loops.

Suggested next step: pick **one** acquisition channel and actually run it, then watch WAU against the 50+ gate. This remains the single most important item in the whole report and is worth promoting to the explicit top-line item in `CLAUDE.md`.

### 2.2 Public intelligence surfaces — 28 sitemapped + 2 gated — `Severity: n/a (shipped) · context`

- **`/insights` hub: 28 routes in the sitemap** (verified: `INSIGHT_ROUTES` in `lib/sitemap-data.ts` = 28 unconditional slugs; `candy-mlb` is appended only when `CANDY_MLB_PUBLIC` flips) against **30 built surface dirs** in `app/insights/`. The delta is **two gated surfaces**: `panini-squeeze` (`proxy.ts` panini gate) and the **NEW `candy-mlb`** board (gated behind the `CANDY_MLB_PUBLIC` flag + a new `proxy.ts` candy line).
- **IA reorg (carried):** `packs` / `pack-sniper` / `hot-floors` / `challenges` stay registered pages but are folded off the top bar; pack surfaces reached via an in-page **Moments \| Packs sub-toggle**. Top Shot **Play hub** fronts Challenges / Fast Break / Road to the Ring.
- **Market vs Sniper split:** Market is **edition-level**, Sniper is **serial-level**. Market defaults to Price ascending.

No open defects tracked here; listed because it is a large body of shipped product sitting in front of anonymous visitors.

### 2.3 Data-intelligence — a new capability *and* a strong bug-finding week — `Severity: was High (correctness) · Effort: large, landed`

**New capabilities:**

- **Pooled special-serial FMV model SHIPPED (07-26).** A **pooled hedonic (ridge) regression** fit offline in Python, coefficients written to service_role-only tables, applied at read time as a per-edition power law (`est = k_edition · fmv^b`). `set` is the dominant factor (~125× premium spread); `player` and `badge` were tested and **rejected** under shrinkage. Live model v1.2.0 = set-only + 180d-recency-weighted + a jersey-#1 double-special multiplier. Validated **out-of-sample** via rolling forward-chaining CV: pooled med-APE ~0.575 vs the incumbent power-law ~0.69 (**~16% better**), broader coverage. **LIVE on every serial-estimate surface** (was board-only): underpriced-serials board, moment page, wallet, trophy, top-owned, and the sniper ticker. Kill-switch: `UPDATE serial_fmv_pooled_model SET is_active=false`. Design in `docs/models/topshot-pooled-serial-fmv-2026-07-26.md`; reproducible fit in `scripts/serial-fmv-pooled/`.
- **Candy chain-two productized (07-24) — last week's "zero price signal" blocker is GONE.** Candy is now printing **~53 sales/24h** (gated, expected); FMV computed by the standard `fmv-recalc` (algo `1.7.0`, **46/125 editions priced, all LOW-confidence off 1–2 sales**; the 79 zero-sale editions stay honest FMV-`—`). Shipped: an **ask feed** (`candy_listings` table + `candy-listings-indexer`), a pack-EV model, parity boards (scarcity/holder/serials/parallel-player/deals/spread), and the **first gated public board `/insights/candy-mlb`**. **Every new Candy table/view is anon+authenticated SELECT-REVOKED** (verified). **Binding honesty constraint held: listings/offers are ASK/BID floors, NEVER folded into `fmv_snapshots`.** Go-live is Trevor's call (delete the `proxy.ts` candy line + sitemap slug + drop `noindex`; the flag `CANDY_MLB_PUBLIC` makes it atomic).

**Correctness fixes (a bug-finding week):**

- **P0 — fabricated pack EV killed at the read layer (07-25).** A **$4.99 Pinnacle pack was publishing $2,651.21 gross EV — a 531× ratio**; an NFL pack published **$900,000** on 3% FMV coverage. Fixed with three **read-layer** guards (drop pool must exist · price < sentinel · FMV coverage ≥ 25%) rather than touching EV math. Published EV rows 1,024 → ~1,000; **max value ratio 531× → 15.3×.**
- **Silent data loss — legacy 2-column wmc unique index dropped (07-25).** A legacy `(lower(wallet_address), moment_id)` index on `wallet_moments_cache` was **discarding whole upsert chunks while `pipeline_runs` reported 0 failures across 3,497 runs** (6,394 moment_ids legitimately exist in 2 collections). Dropped after proving no `ON CONFLICT` caller inferred it. Frees 186 MB.
- **The 57014 retry AMPLIFIER (07-26).** `isTransient()` lacked a SQLSTATE-57014 case, so every statement timeout fell through to a `msg.includes("timeout")` heuristic — and Postgres' 57014 text *contains* that substring, so every timeout was retried 3× and **could not** succeed (a statement that blew its ceiling blows it again). Pure amplification on `edition/*` (51.4% of collection page views) on an IOPS-bound instance. Fixed with a `NEVER_RETRY_CODES` set.
- **23505 batch data-loss eradicated across all 5 forward sales indexers (07-25).** A batch `.insert()` is all-or-nothing; one duplicate `transaction_hash` failed the whole ≤100-row statement and dropped every co-batched *new* sale — and because nothing landed, the cursor advanced past them = permanent loss. Fixed in candy/golazos/allday/ufc (each on `sales` + `unmapped_sales`) and the TopShot `sales-indexer`; pinned by a directory-driven guard so new indexers are covered automatically.
- **AllDay resolver — 4 defects fixed (07-26).** Its tripwire was **unreachable by construction**; one bad stored address (the AllDay contract, not a wallet — the largest single backlog value at 4,816 rows) was suppressing the only resolution leg that works; scan gated + instrumented; a latent error-swallow fixed.
- **FMV coverage (from `metrics-latest.json`, 2026-07-26T08:05Z):** TopShot HIGH 787 / MEDIUM 2,020 / **HIGH+MED 2,807**; AllDay HIGH+MED 463; UFC 15; Golazos 3. *The TS number is down from last week's 3,374 — the documented benign sales-cooldown redistribution; freshness is green (`topshot_fmv_stale_hours` 0.3, `fmv_sanity_flags` 0), so this is confirm-only movement, not a regression.* `edition_integrity_flags` 5; `impossible_parallel` **0**; Pinnacle `fmv_stale` 9.5h; UFC `fmv_stale` 6.9h.

Suggested next step: keep the per-collection `*_fmv_stale_hours` tripwires in the weekly check (trust health is now **20 metrics** for exactly this reason), and treat "the regression test must fail against the pre-fix code" as the standard for correctness fixes (used throughout this week's work).

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (green; one benign flag) · Effort: landed`

- **Security posture GREEN.** `metrics-latest.json`: **0/0/0/0** — `check_public_security_invariants() []`, `check_anon_write_surface() []`, `rls_off_base_tables []`, `secdef_anon_violations []`. The 07-19 confidentiality incident's durable lessons hold: every new Candy table/view this week was **explicitly anon/authenticated SELECT-revoked and verified** with `has_table_privilege`, not `information_schema`.
- **One benign flag to clear (owner action).** The ~11 new Candy views trip `check_public_security_invariants()` `view_unexpected_definer` because they're `security_invoker=true` (normalized to `=on`; the invariant matches only `=on`). **No leak** — all anon/authenticated-revoked; clears once allowlisted. Tracked, not urgent.
- **Test coverage crossed 90% line coverage.** Ratchet **75.5/60.6/80.9/78.0 → 87.3/72.3/90.3/89.85** (live actual ~87.8/72.8/90.8/90.4, ~0.1–0.2 buffer kept for concurrent churn).
- **NEW: a component-coverage CI gate.** Components (~429 `.tsx`) were previously *ungated* and contributed nothing to the ratchet. Shipped `vitest.components.config.ts` (scoped to logic-bearing subtrees) + `npm run test:coverage:components` + a **blocking `component-tests` job**, ratcheting at 20.2/17/19/21.2 so component coverage can only go up.
- **DB-invariant SQL layer grew 12 → 22 pins** (23 `supabase/tests/*.sql` files incl. `_helpers.sql`), adding `serial_fmv_estimate` (the new crown-jewel estimator) and `get_edition_fmv_history`. The DDL drift guard (`__tests__/db-invariants-drift-guard.test.ts`) now tracks all 23.
- **CI is now 7 blocking jobs** (verified in `.github/workflows/ci.yml`): `typecheck`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests`, **`component-tests` (NEW)**, `db-tests`, `ledger-guard`.

### 2.5 Automation / asset hygiene — `Severity: Low · Effort: ongoing`

The autonomous passes are un-blocked and shipping. `metrics-latest.json` is one day old (2026-07-26T08:05Z). **One hygiene flag carries and worsens:** `docs/overnight/focus.md` is still dated **2026-06-24** (last modified Jun 30) — now **~33 days stale** and still describing a June deep-history program as the current priority, which is actively misleading for a launched, post-Candy repo. The inbox is **fully drained** (0 pending), an improvement over last week's 5. `docs/overnight/ledger.md` holds **563** entries (was 413).

### 2.6 Overnight operational queue — `Severity: Low–Medium · Effort: mixed`

**Closed / advanced this week:** the P0 pack-EV, the wmc silent-loss index, the 57014 amplifier, the 23505 class across 5 indexers, AllDay resolver 4-defect fix, three GHA cron-collision staggers, the pg_cron worker-startup-convergence stagger, and `refresh_seeded_wallet_stats` gated (−92.9% of calls). Still open:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **ALLDAY-UNMAPPED-SALES-BACKLOG-GROWTH** | 45,554 open, net +3,589/day — the one HIGH pipeline alert. **Not a regression** — expected unresolvable residue of a *succeeding* backfill; the dominant blocker is edition resolution, not price; no live impact (unpromoted rows never reach `sales`). | **High (carried)** | Resolver-throughput / **off-limits** by policy; the 07-25 NEM-from-sales self-heal (pg_cron jobid 215) drains it as moments re-sell. |
| **DUNE-DATAPOINT-CAP-402** | Both Dune lanes (`sales-ingest-dune` + `sales-seller-recovery-dune`) fast-fail on HTTP 402 datapoint-limit; cursors parked. The whole month's budget went in one day (07-24). | Med | Operator / billing — check the Dune cycle date + datapoint balance directly. |
| **SET-DETAIL-PAGE-POOL-RETRY-GAP** (new) | `get_set_detail` lacks the `rpcWithRetry` wrapper the sibling pages got. | Low | Blocked as a hot-file until `set/[slug]/page.tsx` ages past 48h. |
| **COMPUTE-LALIGA-PACK-EV schema mismatch** | Dies daily inserting a column `pack_ev_history` lacks. Not user-facing (the golazos route covers the collection). | Low–Med | Off-limits pack-EV logic + an ownership call; adding the column is explicitly rejected. |
| **WMC-LOCK-FRESHNESS** | The 7-day `lock_checked_at` promise is structurally oversubscribed and left alone, honestly labelled. (The *ownership*-freshness "crisis" was proven to be the metric, not the pipeline — 07-25 hygiene closeout.) | Low–Med | By explicit decision. |
| **MARKET-EDITION-LINK** | The "full fix" is **proven unbuildable server-side** — TS's numeric edition `flowID` does not exist on the GQL nodes. | Low (terminal) | Do **not** re-attempt the GQL-ingest-column approach. |
| **REFRESH-SEEDED-WALLET-STATS-HOLDINGS-SUMMARY-COST** | Highest total-time consumer; cost is `holdings_summary()`. Gated this week (−92.9% of calls) but the per-call cost remains. | Low–Med | Carried. |
| **Vercel cost family / cron-job.org dropout** | Carried. Seed-wallet 12h gate shipped earlier. Dropout family is external + self-healing. | Low–Med | Trevor (dashboard) + operator. |

### 2.7 Pack EV / pack-viz — `Severity: was High (P0 fixed) · Effort: landed`

The P0 fabricated-EV bug (§2.3) was the pack story of the week — a $4.99 pack publishing $2,651 EV, fixed at the read layer without touching EV math. Pack EV is otherwise accurate-by-construction: the pool-completeness guard holds, and Candy's new `candy_pack_ev_model` leads with **Typical Pull median (~$26)**, not the noisier Actual EV (~$86, Rainbow leg largely unpriced) — the honest default. The June market read stands: the pack-shaped product is not the opportunity; the pricing engine is.

### 2.8 Chain foundation — abstraction closed; two live expansion programs — `Severity: Low–Medium · Effort: Medium`

- **Chain-abstraction Phases A–F complete, and the reorg tail is now CLOSED.** The **18 re-export shims were DELETED** (07-25, Trevor-authorized override of the chain-two gate — verified zero-caller via alias + relative-path grep across all code file types). The canonical modules under `lib/chains/flow/**` are now the ONLY import path; new code MUST import `@/lib/chains/flow/...`. Revert: `git revert <sha>` restores the shims. This ends the report's largest standing in-code TODO cluster.
- **Candy / Solana — productization COMPLETE, go-live is a flag flip.** Last week's blocker (zero price signal) is resolved: ~53 sales/24h, FMV computed, ask feed built, first gated public board `/insights/candy-mlb` live with 10 supporting views (all anon-revoked). `candy_mlb` stays `is_active=false`; the board reads Candy **directly**, so it needs neither the `is_active` flip nor a shared-RPC candy-arm. **Go-live (Trevor's call):** delete the `proxy.ts` candy line + sitemap slug + hub card + OG + drop `noindex` — atomic via `CANDY_MLB_PUBLIC`. **Binding honesty constraint: `candy_best_offers` / `candy_listings` are best-offer/ask signals, NEVER FMV.**
- **Panini — runner LIVE, blocker is editorial (unchanged).** ~1,022 editions refresh every 4h from a residential box. Discovery is **listing-GATED** (~47% trustworthy coverage; falls with scarcity); Panini exposes no full-checklist route, so the only lane is *accept and disclose* — and the disclosure is now **structural** (the page renders a "floor, not a census" banner; the public JSON carries `meta.coverage`). Go-live is a single `proxy.ts:127` deletion + sitemap/hub links + `PANINI-SET-RPC-BRANCH`. Five additional built boards stay deliberately unsurfaced.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** Site public + self-serve signup for a full week; instrumentation verified; reading is **20 users / 0 new signups / 0 WAU**. The gap is demand, not measurement. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| 0 | **Wallet verification.** "Sign in with Dapper" still gated on Dapper developer access. Working path = the on-demand listing challenge (`/api/profile/verify-challenge/check` → `resolve_wallet_challenge_match`, +500 credits); `admin_verify_wallet` is the interim fallback. | Medium | Medium (core shipped; Dapper path blocked externally) |

### Data-intelligence — new capability (this week)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Pooled serial-FMV model | Shipped, live on every serial surface, out-of-sample validated. Follow-up (deliberate): the DB-invariant pin **landed** this week (`serial_fmv_estimate` pinned). Refit is a periodic offline job (a pure-SQL weekly refit is infeasible — no `lstsq` in Postgres). | n/a (shipped) | (landed) |
| Candy productization | First gated board + ask feed live; go-live is a Trevor flag flip. Benign `view_unexpected_definer` flag to allowlist. | n/a (shipped) | Small (owner call) |

### Data-intelligence correctness

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Pack EV integrity (P0) | $4.99 pack published $2,651 EV. **Fixed** at read layer (3 guards); ratio 531×→15.3×. | was **High** | (landed) |
| Silent data-loss class | wmc legacy index discarding upserts; 57014 retry amplifier; 23505 batch-loss ×5 indexers. **All fixed**, each pinned. | was **High** | (landed) |
| Sales counterparty / ingest completeness | Recovery engine live; **both Dune bulk lanes parked on the 402 datapoint cap** — recovery ceilings are the rows we have, not true counts. | Medium | Medium (blocked on Dune billing) |
| AllDay unmapped backlog | 45,554 open, +3,589/day — HIGH alert but **expected residue of a succeeding backfill**, no live impact. | Med (carried) | Off-limits by policy |
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine primary. Legacy `edition_key` is character-LOSSY — never repoint character reads onto it. | Medium | Medium |

### Cost / operational right-sizing

| Item | Issue | Severity | Effort |
|---|---|---|---|
| DB storage | **11,109 MB — UP ~1,055 MB** this week (reversed last week's decline; back over 11 GB). | Low–Med | Small (monitor) |
| IOPS on Micro | **The binding constraint** — drove this week's ops work (retry-amplifier, cron staggers, pg_cron convergence stagger). Read-diet discipline continues. | Medium | Ongoing |
| Vercel cost family | Carried (Spend-Management cap backstop, Fluid/cron/observability levers). | Medium | Small–Medium |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | **CLOSED** — all 18 shims DELETED 07-25. New code imports canonical `@/lib/chains/flow/...` only. | n/a (resolved) | (landed) |
| Candy chain-two | Productization COMPLETE; first gated board live. Go-live = flag flip (Trevor). | Low–Med | Small (owner call) |
| Panini | Runner LIVE; coverage listing-gated (~47%); disclosure structural; bridge built INERT. Blocker: **editorial** + `PANINI-SET-RPC-BRANCH`. | Medium | Small (one line) + a judgment call |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 | Monolith page refactor — **flat this week.** Verified `wc -l`: `collection/page.tsx` **1,618** (flat) · `sniper/page.tsx` **1,705** (+14) · `analytics/page.tsx` **495**. **`CLAUDE.md` #14's figures (~2,900 / ~2,070 / ~2,208) remain STALE** — recommend correcting. Plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (much progressed) |
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **2,366 lines** (+6). | Low | Large |
| 15 | `livetoken-portfolio*.json` scratch fixtures — **RESOLVED** (none git-tracked). | Low (resolved) | Trivial |

### Page polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack/Moment/Set tune-up. This week: fee-net sniper, entity-section policy, Pinnacle serial-FMV wallet, pack/set/team soft-404 hardening. Remaining lower-value tier: modal accessibility (Moment V3 / Set V5), Set B5 (series rollups from first 100 editions — needs an aggregate RPC), Set B7. Audit docs (`docs/archive/audits/{PACK,MOMENT,SET}_PAGES_AUDIT_2026-05-22.md`, present) are point-in-time and partially superseded. | Low–Medium | Medium (mostly done) |
| 11 | Brand punch list — token sweep complete; CI guard (`scripts/check-brand-tokens.mjs`, present). Remaining: longer-tail surfaces (email HTML, Fast Break / RTR / admin). | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, **198 lines** verified) — shelved, still no UI / no importer. | Low | Small |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** Cadence dormant in `lib/chains/flow/cadence/purchase-moment.ts` (verified present). Not a defect. | n/a (shelved) | n/a |
| #3 | Trade Hub / trade-escrow — **SHELVED + GUARDED.** **Now just 6 in-code stub TODOs** (`lib/trade-escrow/fcl-submit.ts`) after the cancel-callback route + `sign-cancel.ts` landed this week (07-25) — the `TradeChainPanel.tsx` cancel TODO is RESOLVED. Contract suite is 16/16 green in CI. | Medium (shelved) | Large |
| — | Breaks — dormant (tables not in prod, migration unapplied). Hot-wallet signing bug fixed earlier. | Low (dormant) | n/a |

### Deferred hardening (intentional — from `CLAUDE.md`)

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each retain a `roles=public` INSERT policy with `qual=true`/`with_check=true`. Future hardening: per-row size caps, a `created_at` rate-limit column/trigger, a `bot_score` column, possibly an edge rate-limiter.
- `user_achievements` + `watchlist_items` — service-role-only writes but still keyed on `owner_key` (text) rather than `user_id` (UUID).
- `badge_editions.low_ask` — **AllDay RESOLVED** (live 30-min cron). **Golazos NEWLY WIRED this week** (07-25): `resolve_golazos_listing_edition_ids()` + `golazos_edition_floor_ask` + a `rpc-golazos-badge-low-ask-refresh` pg_cron job shipped; `edition_id` went 0→426, the feed unfroze (07-21 → 07-25). The old "Golazos frozen" note is now stale; `highest_offer` coverage remains the residual gap.

### Architecture note worth tracking

- **Watchlist + FMV Alerts** — the legacy `fmv_alerts` mis-route is retired; the live feature is the `alert_subscriptions` / `notification_channels` / `lib/alerts.ts` implementation. Reconcile the old watchlist tables before any reactivation.
- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design (long-form vs short-form collection strings; `HIGH|MEDIUM|LOW` vs `HIGH|MED|LOW`). Both are documented in `CLAUDE.md` and worth re-reading before writing any new query.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old 2026-05-24 two-item list is replaced by `docs/strategy/roadmap-2026-07-18.md` (verified present), which is canonical:

| Phase | Action | Status |
|---|---|---|
| 1 | **Prove the product with real users — the only gate that matters is 50+ WAU.** | **Open — the critical path.** Instrumentation done; traffic is the gap; a full week public reads 0 WAU (§2.1). |
| 2 | Cost / latency levers. | Advancing — IOPS read-diet was the week's theme (retry-amplifier, cron staggers, pg_cron convergence stagger, seeded-wallet-stats gate). |
| 3 | Durable debt. | Advancing — 18 shims deleted; monoliths flat; profile consolidation, mobile polish, `/dashboard` refactor remain. |
| 4 | Chain two, **readiness-gated**. | **Candy productization complete** (go-live a flag flip); Panini blocked on an editorial call (§2.8). |

**Standing guardrails from the roadmap:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (cron-job.org, GHA, `vercel.json`, pg_cron, in-repo fetches).

**Housekeeping still outstanding:** the old Priority #1 (Flowty teardown) is **obsolete** — the API is alive and feeds live ingest; formally close it in `CLAUDE.md`.

---

## 5. In-code TODO inventory

A first-hand `ripgrep` scan over `*.{ts,tsx,js,jsx,mjs,cjs,cdc,sql,css}` (excluding `node_modules`/`.next`/`.git`) returned **37 raw matches across 18 committed-tree files** (+1 vendored marker in a gitignored fetched contract). Excluding **3 hard false positives**, **1 vendored contract marker**, **~10 descriptive test references**, and **~17 resolved-annotation / discovery-tool / draft lines** (all itemized in §8) leaves **6 real actionable markers in 1 file** — **−28 vs last week's 34.** Grouped by theme:

### 5a. Chain-rename shims — Phase-D reorg tail (0 markers) — **RESOLVED (−18 this week)**

**The entire cluster is gone.** All 18 re-export shims (`lib/flow.ts`, `lib/topshot.ts`, `lib/allday.ts`, the seven `lib/cadence/*` shims, etc.) were **DELETED** on 07-25 (Trevor-authorized). Verified: `ls lib/flow.ts lib/topshot.ts lib/allday.ts` → all "No such file or directory". This was the largest standing TODO cluster in the report's history; it is now closed.

### 5b. Trade Hub / escrow — feature stubbed but guarded (6 markers, 1 file) — **−2 this week**

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 75, 85, 104, 112, 122) — the header block plus all five trade transactions are stubs, fronted by `ensureLive()` so they throw rather than return fake tx ids.
- ~~`app/dashboard/trade-hub/TradeChainPanel.tsx` (lines 186, 196)~~ — **RESOLVED (07-25).** The cancel-callback route (`/api/trade-chain/cancel-callback`) + client stub `lib/trade-escrow/sign-cancel.ts` landed and `TradeChainPanel.onCancel` now calls it (was console-log-only). Zero `.tsx` TODO markers remain repo-wide.

→ See §3 (#3). The contract side is 16/16 green in CI. **This is now the only real actionable cluster in the codebase.**

### 5c. `special-serial-sweep` ownership lookup (0 markers) — unchanged, still resolved

A whole-tree scan of `supabase/functions/` returns zero markers.

### 5d. Pipeline calibration (0 actionable) — **RESOLVED (−1 this week)**

- ~~`app/api/rtr/lock-roi/route.ts` `TODO(lock-roi-calibration)`~~ — **RESOLVED (07-24).** The v1 `floor(fmv/10)` placeholder was replaced by a tier+serial-scarcity-weighted v2 (`lib/rtr-lock-roi-weights.ts`). The lines the scan now matches (`route.ts:38`, `rtr-lock-roi-weights.ts:7`) are **resolved-annotation comments** ("v2 folds in the two signals the v1 TODO called out"), not actionable.

### 5e. Smaller data-quality / polish TODOs (0 markers) — **RESOLVED (−1 this week)**

- ~~`app/api/pinnacle-wallet/route.ts:76`~~ — **RESOLVED.** The wallet-scoped offer-totals TODO is gone; the pinnacle-wallet surface was un-gated and its offer path wired this week. Zero markers remain in this file.

### 5f. Cadence test coverage gap (0 markers) — unchanged, resolved

- `cadence/tests/RPCTradeEscrow_test.cdc` — **zero TODO/FIXME markers** (verified count 0). Suite runs 16/16 green in the `cadence-escrow-tests` CI job.

### 5g. Candy / Solana chain-two placeholders (0 actionable) — unchanged, resolved

`lib/chains/solana/normalize.ts` exports real Candy values. The 7 lines the scan matches are **`TODO_N RESOLVED` annotations** plus the permanent `.startsWith("TODO_")` route guards (which stay by design as a safety net) — none actionable. The two route-level guard strings (`candy-sales-indexer:133`, `candy-editions:93`) are unreachable-in-practice messages.

### 5h. Panini discovery placeholders (0 live-surface markers) — unchanged

- **Live surface: 0 markers.** Remaining matches are **draft/reference only**: `docs/drafts/panini/*` (×5 across 3 files) and `scripts/ingest-panini-runner.mjs:16` (a header comment referencing the resolved grid-enumeration question — arguably stale, worth a one-line comment update rather than work).

> **Net change since last week:** **−28 real markers / −16 files** (34/26 → 6/1). Four clusters resolved: §5a shims 18→0 (deleted), §5b Trade-Hub-cancel 2→0, §5d lock-roi 1→0 (v2 shipped), §5e pinnacle-wallet 1→0. Trade Hub `fcl-submit.ts` (§5b, 6 markers) is now the **sole** real actionable cluster.

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, and `docs/overnight/metrics-latest.json`:

**Known-issue slate (carried, all still resolved):** #2 (Sentry — 0 unresolved), #3 (Flowty event indexer — frontend shut, API alive), #4 (Pinnacle FMV — per-render engine primary), #5 (AllDay/UFC mis-categorized — only 8 stray), #6 (WarmupContext key — `lib/warmup/WarmupContext.tsx` present), #7 (AllDay `unmapped_sales` — resolver rewritten; the current 45,554 backlog is *expected succeeding-backfill residue*, not the original defect), #8 (NBA projections — syncing), #13 (`flowty_archive` growth — pruned), #15 (scratch fixtures — none tracked), #16 (`flow test` CI — blocking), plus the fmv-recalc silent stall.

**Newly resolved / closed this week:**
- **Pooled special-serial FMV model — SHIPPED** and live on every serial surface; out-of-sample validated; DB-invariant pin landed.
- **Candy chain-two — PRODUCTIZED.** Price signal arrived; FMV + ask feed + first gated board `/insights/candy-mlb` + 10 anon-revoked views. Go-live is a flag flip.
- **P0 fabricated pack EV — KILLED** at the read layer (531×→15.3×).
- **Legacy 2-column wmc unique index — DROPPED** (silent upsert-chunk loss under "0 failures"; frees 186 MB).
- **57014 retry amplifier — FIXED** (3× DB load on 51% of collection views eliminated).
- **23505 batch data-loss — ERADICATED** across all 5 forward sales indexers, pinned by a directory-driven guard.
- **AllDay resolver — 4 defects fixed** (unreachable tripwire, buyer-leg suppression, scan gating, error-swallow).
- **18 chain-rename shims — DELETED** (Phase-D tail closed).
- **Trade Hub cancel-callback — LANDED** (`TradeChainPanel.tsx` TODO resolved; feature stays shelved).
- **lock-roi calibration — v2 SHIPPED** (tier+serial-weighted; the v1 TODO resolved).
- **Component-coverage CI gate — SHIPPED** (7th CI job).
- **Golazos badge low_ask — WIRED** (cron + resolver shipped; feed unfroze).
- **Three GHA cron-collision staggers + a pg_cron worker-startup convergence stagger — SHIPPED.**
- **`refresh_seeded_wallet_stats` — gated** (−92.9% of calls).

---

## 7. Suggested sequence

A pragmatic order under the **post-launch** framing (`docs/strategy/roadmap-2026-07-18.md`):

1. **Drive traffic to the now-public site (§2.1).** The only gate is 50+ WAU. A full week public reads 0 WAU — the assets (28 sitemapped insights boards, OG cards, a working concierge, live alert loops) exist and are idle. Pick one channel and run it. This is unambiguously #1.
2. **Make the Candy go-live call (§2.8).** The board, ask feed, and 10 views are built, gated, and anon-revoked; go-live is a single `CANDY_MLB_PUBLIC` flip + `proxy.ts` line + sitemap slug. Also allowlist the ~11 benign `view_unexpected_definer` Candy views.
3. **Make the Panini editorial call (§2.8).** Bridging a ~47%-coverage listing-gated index into the shared catalog is a judgment call; go-live is one `proxy.ts:127` line + `PANINI-SET-RPC-BRANCH`.
4. **Clear the operator items (§2.6).** Check the Dune billing cycle / datapoint balance to un-park both Dune lanes; give `get_set_detail` the `rpcWithRetry` wrapper once `set/[slug]/page.tsx` ages past 48h.
5. **Refresh the autonomous-pass steering (§2.5).** `docs/overnight/focus.md` is ~33 days stale and still describes a June program as current — actively misleading now.
6. **Let the correctness + intelligence work soak (§2.3).** Keep the per-collection `*_fmv_stale_hours` tripwires (trust health is 20 metrics for this reason); watch the pooled serial-FMV model and the AllDay residue self-heal.
7. **Cost / IOPS posture (§2.6).** DB rose ~1 GB this week and IOPS is the binding constraint — keep the read-diet discipline and do the Vercel Spend-Management cap backstop regardless.
8. **Chain-foundation + debt tails as capacity allows.** The 18 shims are gone; next is `/dashboard` (#10, 2,366 lines) and the page/brand tail (#17, #11).

---

## 8. Notes from verification

- **Git available this run.** `git log --since='2026-07-20 17:20'` → **295 commits**; `git diff --stat "@{2026-07-20}" HEAD` → **620 files changed, +54,778 / −6,109**. Per-day: 07-20 (partial) **30** · 07-21 **18** · 07-22 **0** · 07-23 **0** · 07-24 **46** · 07-25 **177** · 07-26 **45** · 07-27 **0** (app dormant 07-22 → 07-24; today no commits yet). Directories touched most: `__tests__` (259), `docs` (84), `app` (73), `lib` (65), `supabase` (63), `components` (42).
- **Line counts are real `wc -l`:** `collection/page.tsx` **1,618** · `sniper/page.tsx` **1,705** · `app/dashboard/page.tsx` **2,366** · `analytics/page.tsx` **495** · `lib/blazers-trivia.ts` **198**.
- **Stale figures in `CLAUDE.md` #14** — it still lists collection ~2,900 / sniper ~2,070 / analytics ~2,208. All three remain wrong (actual 1,618 / 1,705 / 495). Recommend correcting.
- **TODO scan: 37 raw matches / 18 committed-tree files → 6 real markers / 1 file.** Exclusions:
  - **3 hard false positives:** `lib/format.ts:6` (`"$X,XXX.XX"`), `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql:17` (`audit_2026XXXX_`), `supabase/migrations/20260624162548_….sql:6` (`numeric_numeric_recXXX`).
  - **1 vendored contract marker (gitignored, fetched dep):** `cadence/contracts/imports/ExampleNFT.cdc:366` (upstream Flow example, not RPC-authored). The `cadence/contracts/imports/` dir is `.gitignore`d (confirmed via `git check-ignore`), so it is outside the committed-tree count.
  - **~10 descriptive test references:** `__tests__/api-candy-sales-indexer-deep.test.ts:125`, `api-ingest-candy-offers-deep.test.ts:104`, `api-wallet-backfill-candy.test.ts:13,40`, `solana-normalize.test.ts:115,117,118,119,124,131` — assertions that the `TODO_`-prefix guards behave, not markers.
  - **~17 resolved-annotation / discovery / draft lines:** `lib/chains/solana/normalize.ts` ×7, the two candy route guard strings, `app/api/rtr/lock-roi/route.ts:38` + `lib/rtr-lock-roi-weights.ts:7` (v2-shipped annotations), `supabase/migrations/20260713050000_….sql:4` + `20260624162548_….sql` (records of resolved TODOs), `scripts/ingest-panini-runner.mjs:16`, and `docs/drafts/panini/*` (×5).
- **Cluster resolutions verified by inspection, not inferred:** `lib/flow.ts`/`lib/topshot.ts`/`lib/allday.ts` all absent (shims deleted); `app/dashboard/trade-hub/TradeChainPanel.tsx` and `app/api/pinnacle-wallet/route.ts` return 0 TODO markers; `cadence/tests/RPCTradeEscrow_test.cdc` count 0.
- **CI: 7 blocking jobs verified** in `.github/workflows/ci.yml`: `typecheck`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests`, **`component-tests` (NEW)**, `db-tests`, `ledger-guard`. **23** `supabase/tests/*.sql` files (22 invariants + `_helpers.sql`; drift guard references all 23). **880** test files under `__tests__/`. **16** worker dirs under `workers/`. **34** `"schedule"` entries in `vercel.json` (was 32).
- **Coverage ratchet read directly from `vitest.config.ts`:** thresholds **87.3 / 72.3 / 90.3 / 89.85**. `CLAUDE.md` records live actuals of **87.80 / 72.82 / 90.83 / 90.36** — **line coverage crossed 90% this week.** `vitest.components.config.ts` present with its own ratchet.
- **`/insights`: 28 sitemapped routes** (`INSIGHT_ROUTES` in `lib/sitemap-data.ts` = 28 unconditional slugs; `candy-mlb` appended only when `CANDY_MLB_PUBLIC` flips) vs **30 built surface dirs** in `app/insights/`. The delta is two gated surfaces: `panini-squeeze` + the new `candy-mlb`.
- **No active freeze.** `docs/FREEZE.md` verified absent.
- **`docs/overnight/focus.md` is ~33 days stale** (dated 2026-06-24, last modified Jun 30). `docs/overnight/inbox/` holds **0** undrained ticks (drained). `docs/overnight/ledger.md` has **563** `### ` entries (was 413).
- **Cited paths spot-checked — all resolve:** `docs/strategy/roadmap-2026-07-18.md`, `docs/audits/refactor-plan-monolith-pages-2026-05.md`, `docs/trade-escrow/DEPLOYMENT.md`, `docs/archive/audits/PACK_PAGES_AUDIT_2026-05-22.md`, `scripts/check-brand-tokens.mjs`, `lib/warmup/WarmupContext.tsx`, `lib/chains/flow/cadence/purchase-moment.ts`, `app/insights/candy-mlb/`, `supabase/tests/README.md`, `vitest.components.config.ts`. **Note the one stale reference from last week persists:** `CLAUDE.md` known-issue #3 cites `RPCTradeEscrow_DEPLOYMENT.md`, which is at **`docs/trade-escrow/DEPLOYMENT.md`**.
- **DB-side facts** (FMV counts, editions, DB size 11,109 MB, trust 20 metrics / 0 breaches, security 0/0/0/0, sentinel 0, `impossible_parallel` 0, `edition_integrity_flags` 5, Sentry 0, artifacts 15, traction 20 users) come from **`docs/overnight/metrics-latest.json` (2026-07-26T08:05:06Z — one day old)** plus `CLAUDE.md`'s 07-24/25/26 entries. They were **not** independently re-queried against production Supabase this run, consistent with prior reports.
- **Autonomous-task caveat:** the daytime monitor and night pass run against this repo, so the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-07-27)

Every slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | Open | **Open** — listing-challenge path live; Dapper-dev path blocked externally | `app/api/profile/verify-challenge/check/route.ts` present |
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `lib/chains/flow/cadence/purchase-moment.ts` present |
| 2 | Sentry inactive | Resolved | **Resolved** | 0 unresolved/24h per metrics |
| 3 | Flowty event indexer **/ Trade Hub** | Resolved (Flowty) **+ Shelved (Trade Hub)** | **#3 double-assigned** — Flowty resolved; Trade Hub shelved + guarded; **cancel-callback landed 07-25 → 6 stub TODOs (was 8)**; contract suite 16/16 in CI | `fcl-submit.ts` (6 markers); `cadence-escrow-tests` job |
| 4 | Pinnacle FMV | Resolved | **Resolved + enhanced** — per-render engine primary | `pinnacle_fmv_history` live |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `lib/warmup/WarmupContext.tsx` present |
| 7 | AllDay `unmapped_sales` | Resolved | **Resolved (original defect)** — the current 45,554 backlog is *expected succeeding-backfill residue*, off-limits | `CLAUDE.md` + ledger |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired | **Retired** | prior runs |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = **2,366** lines (+6) | `wc -l` |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — token sweep complete; CI guard present | `scripts/check-brand-tokens.mjs` present |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | `wc -l` |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open — flat this week** — collection **1,618** / sniper **1,705** / analytics **495**. **All three `CLAUDE.md` figures STALE** | `wc -l` |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** — none git-tracked | prior runs |
| 16 | `flow test` in CI | Resolved | **Resolved — and expanded**: 7 CI jobs incl. `cadence-escrow-tests`, `db-tests`, and NEW `component-tests` | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set page tune-up | Open (ongoing) | **Open — fee-net sniper + entity-section policy + Pinnacle serial-FMV wallet landed this week** | audit docs present; a11y + Set-RPC tail remains |

**Tally:** 10 resolved (#2, #3-Flowty, #4, #5, #6, #7, #8, #13, #15, #16) · 2 shelved by decision (#1 Cart, #3 Trade Hub) · 1 retired (#9) · 6 open or partial (#0, #10, #11, #12, #14, #17). Plus the live, un-numbered **public go-live + self-serve signup**, **pooled serial-FMV model**, **Candy first gated board**, **component-coverage CI gate**, **Panini runner + gated surface**, and the 28 public `/insights` surfaces.

**Bottom line for `CLAUDE.md`:** the numbering is unchanged; recurring recommendations still stand, plus one that got materially better: (a) **resolve the #3 numbering collision** — give Trade Hub a fresh number (e.g. #18); (b) **correct #14's line counts** — all three stale (actual 1,618 / 1,705 / 495); (c) **fix the one stale path** — #3 cites `RPCTradeEscrow_DEPLOYMENT.md`, now at `docs/trade-escrow/DEPLOYMENT.md`; (d) **formally close the obsolete Flowty priority**; (e) the in-code TODO inventory has collapsed to a **single** real cluster (the 6 Trade Hub `fcl-submit.ts` stubs) after the 18 shims were deleted — worth a one-line note; (f) the `badge_editions.low_ask` deferred-hardening note is now stale for **Golazos too** (wired 07-25) — only `highest_offer` coverage remains. And the top-line framing is unchanged and hardening: with the site public and self-serve signup open a full week, the reading is **20 users / 0 new signups / 0 WAU** — **demand is the one number that decides everything**, and it has not moved.
