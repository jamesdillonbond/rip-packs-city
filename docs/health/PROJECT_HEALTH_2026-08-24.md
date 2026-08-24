# Rip Packs City — Project Health Report

**Date:** 2026-08-24
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (Known issues §, Deferred hardening §, current through the 2026-08-23/24 entries), `docs/audits/deep-audit-register.md` (**run 3, 2026-08-22**) + `docs/audits/deep-audit-2026-08-22.md`, `docs/overnight/metrics-latest.json` (captured **2026-08-24T08:12Z / 01:12 PT**, same day), `docs/overnight/focus.md` (**now current — dated 2026-08-17**), `docs/overnight/ledger.md` (**1,916** `### ` entries), `docs/overnight/inbox/` (**225 files; INDEX asserts 224 live**), plus a first-hand `git log` + `ripgrep` scan and file-existence verification (the workspace shell is **GREEN** this run).
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (now `#0–#30`), the deep-audit register (`D…`/`R…` findings), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-08-17.md` (7 days ago). This regeneration mirrors its structure. `_2026-08-10.md` … `_2026-05-22.md` (sixteen prior reports) also live in `docs/health/`.

> **✅ Tooling note — shell GREEN, git PUSH still dead in the cloud sandbox (unchanged cause).** Real `git`/`rg`/`wc` this run: measured commit counts, line counts, and a first-hand TODO scan. ⚠ **`git push --dry-run origin main` = `could not read Username for 'https://github.com'`** — the mounted clone's `remote.origin.pushurl` carries no credential, so autonomous **code deploys from the cloud Cowork session remain blocked**. This is scoped to the cloud sandbox: **Trevor's Windows box and Claude Code push normally**, and in fact did most of this week's shipping (see below). The 08-24 overnight pass shipped **0 to prod** for this reason; ~200 consumed inbox files remain un-archived pending a push-capable pass.

> **⚠ Date nuance.** The harness stamps today as **2026-08-24** (UTC); the freshest metrics were captured **08:12Z = 01:12 PT Aug 24**. Ledger/session dates in `CLAUDE.md` are Pacific. Filed under **2026-08-24** per the weekly-regeneration convention (prior report 08-17, exactly 7 days back).

> **Report location stays clean.** All seventeen reports (this one included) live in `docs/health/`; the repo root holds none.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/audits/deep-audit-register.md` for the deep-audit findings. This doc reorganizes all three for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-08-17 — a deep-audit-driven correctness week, shipped from Trevor's box while the cloud pass stayed read-only.** Four stories. **(1) Monthly deep-audit run 3 (2026-08-22) ran and drained hard.** Six parallel sweeps plus a register re-verification; it found **11 register OPEN items already fixed** inside the 134 commits its clone was behind, refuted several severity/liveness claims (R6 in part, R20 as "done not throttled", R43's generalization), and closed a batch of P1s (R18, R22, R23, R42, D12b) same-day. **(2) The known-issue register nearly doubled its numbered slots — `#0–#18` became `#0–#30`** — because run 3 plus the concurrent Claude Code work surfaced and mostly *resolved* a dozen instrument-and-honesty defects (see §9). **(3) The saturation was formally characterized as STRUCTURAL and Trevor decided (08-23) not to buy out of it** (R46: **8,227 GB read in 10d18h, `dealloc=0`, ≈4.5 backends busy at all times on 2 cores** — nothing has to break for this instance to be saturated). That reframes a long tail of "pipeline X is failing" items as *symptoms* of one root cause that will not be fixed with capacity. **(4) `#8` sports-proxy 403 got worse on re-measurement:** ESPN now **403s residentially too**, so the "route ESPN through a Cloudflare Worker" fix is **measured dead**; the failure-rate alarm exists and is deliberately suppressed to 2026-10-14.

> **Overnight reality — GREEN-with-known-saturation-noise; NO-PUSH (cloud).** The 08-24 genuine-overnight pass (01:12 PT) shipped **0** — shell GREEN, cloud git push credential missing, and nothing clearly-safe + net-positive to ship without one. Post-ship watch over the last three ships (all from push-capable sessions) was **GREEN, one strongly positive** (the `panini_squeeze` cutover took `public_board_liveness_sweep` to 45/45 twice, vs 0/45 and 6/45 before). Health at capture: security **0/0/0/0**; **2 trust breaches, both pre-known/structural**: `public_board_slow_count=3` (candy-mlb boards) and `unmapped_resolution_backlog_max=361` (All Day ~47k actionable, ~1047 days — a permanent floor). `trust_precompute_max_age_hours=5.27`. Down from 3 breaches last week (the `panini_sale_price_capture_dry_days` arm is no longer in the set).

> **Traction reality — RE-CAPTURED this run for the first time since 2026-07-26, and it is the headline concern.** Signed-in **WAU = 0**, **21 total accounts (+1 in four weeks)**, **0 signups in 7 days**, newest signup 2026-08-08, newest sign-in 2026-08-14, MAU 2. The roadmap's accuracy gate — the share of prices at HIGH/MEDIUM confidence — stands at **30.1%** (aggregate, per the 08-23 filing). The site has been public since 07-17 and self-serve since 07-20; the machinery is built, instrumented, and idle. **Demand — not features, not correctness, not measurement — is the one number that decides everything, and it is confirmed flat.** Per the roadmap this is the *correct* output of the current input: accuracy is the gate and the product is deliberately not being promoted.

> **Cost / storage — UP again.** DB is **13,848 MB, +734 MB** over last week's 13,114. **Disk-IO on the SMALL (2 GB / 2-core) Supabase instance is the binding operational constraint, and it has now been characterized as STRUCTURAL saturation (R46) that Trevor decided on 2026-08-23 not to buy out of.** It is the direct cause of the `public_board_slow_count` breach, the fmv-recalc kill rate (52.9%), the `get_collection_stats`/`get_series_editions` timeouts, the `/sitemap/3.xml` truncation (#28), and the `topshot-active-listings-ingest` DB-timeout stall (#30). The documented lever is **fixing expensive queries and precomputing, NOT upgrading the tier** (Medium is the same 2 cores for 4× the cost) — and, now, accepting that some pipelines stay red until their queries are cut down.

> **Platform context (unchanged).** **(1) Flowty** frontend shut but API ALIVE and feeding live ingest. **(2) NFL All Day** primary pack sales ended; secondary-market only. **(3) UFC Strike** Flow market frozen (0 sales; honestly labelled). **(4) Candy / Solana** — PUBLIC since 07-31. **(5) Panini** — PUBLIC since 08-01 (listing-gated coverage disclosed structurally). **(6) Expansions are readiness-gated, not sequence-gated.**

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md` — **1,916** entries, `inbox/` — **225 files**, `metrics-latest.json`, `focus.md` — **now current**, `.lock`). `docs/FREEZE.md` (absent this run → no freeze) halts all autonomous shipping. **Check `docs/overnight/ledger.md` and `docs/audits/deep-audit-register.md` before acting** — items below may move without a human in the loop, and much of this week's work landed from Claude Code on Trevor's box, not the cloud pass.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#30** | **Twelve new slots (#19–#30) since last week**, most from deep-audit run 3 + concurrent Claude Code work. See §9. |
| Known issues — resolved this week | 4 | **#19** (pg_cron ownership block / jobid 70 moved), **#24** (6 stale DB pins → 189/189 clean), plus **#26** privilege-half fixed and the run-3 P1 batch (R18/R22/R23/R42/D12b). — §9 |
| Known issues — open / partial | **~11** | #10, #11, #14, #17, #21, #22, #23, #25, #26 (flaps), #28, #29, #30 (+ carried #0, #8). — §3 / §9 |
| Known issues — **REGRESSED / re-measured-worse** | **1** | **#8 sports-proxy 403** — ESPN now 403s residentially too; "proxy ESPN" is **measured dead**; alarm exists, suppressed to 2026-10-14. — §2.3 / §9 |
| Known issues — 🚨 SECURITY, needs Trevor | **1** | **#22** — the 2026-08-03 credential purge was DEFEATED by a stale ROOT-branch of the PUBLIC repo (`claude/todo-implementation-e4tib3`); pre-purge blob still fetchable. Triage `ee94c8a2a`, delete via GitHub UI, GC, rotate regardless. — §2.4 |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot, 2026-08-01). Verified still absent. |
| **Deep-audit register (run 3, 2026-08-22)** | **many closed; a handful open** | Run 3 closed R18/R22/R23/R42/R43/D12b + found 11 prior OPENs already fixed. Still open/owed: R6 (re-measure IN SATURATION), R21 (29 uncommitted edge fns), R46 (structural saturation — decided, not fixed), R52 (precomputed latest-FMV-per-edition). — §2.3 / §3 |
| Commits this week | **~690** | Measured (`git log --since 2026-08-17`): 143 (17th) · 47 (18th) · 0 (19th) · 51 (20th) · 55 (21st) · **286 (22nd)** · 107 (23rd) · 1 (24th). Quieter than last week's 843; the 08-22 spike is run 3 + its fix wave. HEAD `8ee00825` (2026-08-23 22:46 PT, a ledger commit). |
| Net-new shipped / landed this week (not numbered) | **many, from Trevor's box** | 6 stale DB pins re-pinned + assertion-reviewed (189/189 green); jobid 70 rescheduled (MV refresh 16.5× under wall); `/api/ready` privilege leak revoked; 5 of 25 drifted edge fns onto the import map; GHA detector-health sentinel arm; cross-collection mats lock-window fix; `funnel_events` bot flag; multiple honesty-panel fixes (candy-mlb, entity pages, order-book). — §2 / §6 |
| Open overnight operational items | **~8 active + standing queue** | NO-PUSH (cloud, operator); R46 structural saturation (fmv-recalc 52.9% kill, board-MV timeouts); #30 topshot-active-listings DB-timeout; #28 sitemap truncation; #22 stale public branch (operator); #8 sports-proxy 403 (operator, deferred ~Oct); #21/#23 edge-fn drift (operator) — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana (PUBLIC) + Panini (PUBLIC); multi-chain abstraction Phases A–F complete — §2.8 |
| Prioritized next actions | **superseded** | `docs/strategy/roadmap-2026-08-03.md` is canonical (accuracy-is-the-gate; stamped 2026-08-23). Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **0 actionable in live app code** (+2 candy launch-flag "note" branches by design, +6 solana readiness-guard refs, +draft-doc `RESOLVED`/`CLOSED` lines, +1 migration comment, +a few resolved-narrative false positives) | Measured via `ripgrep` — §5 |
| Test / DB-invariant pins | **189 pins** (181 `supabase/tests/*.sql` files incl. `_helpers.sql`) | Was 180. Sweep verified live green 189/189 on 2026-08-23. |
| CI blocking jobs | **10** | Added **`tree-corruption`** (was 9): `typecheck`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests`, `component-tests`, `worker-tests`, `db-tests`, `ledger-guard`, **`tree-corruption`**, `edge-deno`. |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** A correctness-hardening week, most of it shipped from Trevor's box while the cloud pass stayed read-only under the persistent NO-PUSH. Deep-audit run 3 ran a full six-sweep pass, found **11 register items already fixed**, and closed a wave of P1s the same day (order-book honesty, candy-mlb panels, cross-collection staleness, funnel bot-flagging, the shared comment-stripper blind spot). The register's numbered slots nearly doubled (`#0–#18` → `#0–#30`), but the character of the new slots is *instruments that were quietly lying* — a red-for-14-days edge-fn-drift check, six live-drifted DB pins, an 8-day `/api/ready` 500 that was actually a privilege *leak* being closed, a sitemap serving a truncated set under a 200 — and most were resolved or correctly triaged rather than left open. Two things genuinely need Trevor: **the defeated credential purge (#22)** and **the sports-proxy 403 (#8)**, which re-measured *worse* (ESPN 403s residentially now). The board is GREEN-with-known-saturation-noise (2 trust breaches, both structural). Descending, concentrated risk: **(1) demand** — WAU re-captured at **0** against a 50+ gate, accuracy gate at 30.1%; **(2) structural disk-IO saturation (R46)** — now a *decided* constraint, driving the fmv-recalc kill rate, the board-MV timeouts, #28 and #30; **(3) the standing operator items** — the credential purge (#22), the sports-proxy 403 (#8), the edge-fn drift (#21/#23); **(4) the cloud NO-PUSH**, which keeps the autonomous pass read-only.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public since 07-17; self-serve since 07-20. Funnel wired. **Re-measured 2026-08-23: 0 WAU / 21 users / 0 signups-7d.** Accuracy gate 30.1%. The problem is *demand*. Gate: **50+ WAU** (§2.1) |
| **Deep-audit run 3 + instrument honesty (the week's substance)** | 11 prior OPENs found already fixed; P1 batch closed (R18/R22/R23/R42/D12b); red-for-14-days edge-fn-drift + db-pin-staleness surfaced; GHA detector-health arm shipped (§2.3 / §2.4) |
| Data-intelligence correctness / honesty | Order-book "dead-table published as depth" fixed (D12b); candy-mlb panels degrade per-section (R18); entity pages degrade in-brand (R19); sitemap truncation (#28) still OPEN — the house "failed read renders as a fact" class (§2.3) |
| **Structural saturation (decided, not fixed)** | R46: 8,227 GB / 10.75d, ≈4.5 backends busy on 2 cores; Trevor decided 08-23 no capacity change. Symptoms: fmv-recalc 52.9% kill, #28, #30, board-MV timeouts (§2.6) |
| **Regressions / operator-owned** | **#8 sports-proxy 403** (ESPN now 403s residentially → proxy-ESPN dead; suppressed to Oct); **#22 defeated credential purge**; **#21/#23 edge-fn drift** (§2.3 / §2.4) |
| Security | **0/0/0/0** invariants; `/api/ready` anon leak of user/wallet counts REVOKED (#26/R44); the standing debt is **#22 (stale public branch, operator)** (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** (2026-08-01) — verified still absent (§2.9) |
| Chain expansion — BOTH boards PUBLIC | Candy `/insights/candy-mlb` (07-31); Panini `/insights/panini-squeeze` (08-01) — launch flags verified `true` (§2.8) |
| Cost / operational right-sizing | **DB 13,848 MB — UP ~734 MB.** Disk-IO saturation is STRUCTURAL (R46) and a decided constraint — fix expensive queries / precompute, don't upgrade (§2.6) |
| Operational / overnight queue | **NO-PUSH (cloud, operator)**; #30 topshot-active-listings DB-timeout; #28 sitemap; fmv-recalc 52.9% kill; board-MV timeouts; #29 allday-pack-opens rate (§2.6) |
| Tech debt / refactor | Monoliths remain thin `page.tsx` + `*Client.tsx`: CollectionTabClient **1,347** / SniperClient **1,804** / CollectionAnalyticsClient **1,840** / DashboardClient **2,613** (measured this run) (§3) |
| Instrument hygiene | focus.md **refreshed** (was 54d stale, now dated 08-17); ledger 1,916 entries; ~200 un-archived inbox files pending a push-capable pass; Sentry **dark since 08-18** (§2.5) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled: no offer source exists — do not build the indexer) |

---

## 2. Critical path — start here

Go-live is **done**; **`docs/strategy/roadmap-2026-08-03.md`** is the canonical forward plan (stamped 2026-08-23). Its thesis: **accuracy is the GATE, not a phase** — "zero users is the correct output of the current input," so every growth tactic is removed rather than demoted until the data beats the sites collectors already use. Headline metric: **share of prices at HIGH/MEDIUM confidence** (30.1% aggregate this week). The only user gate remains **50+ WAU**.

### 2.1 Launch + activation — the site is public; demand is the gap — `Severity: High · Effort: Medium (built + measured, needs traffic)`

The un-gate shipped 07-17; self-serve magic-link signup opened 07-20. Read-only tabs are anonymous for the 5 published Flow collections; cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction was RE-MEASURED this run (first capture since 2026-07-26):** **21 total accounts (+1 in four weeks), 0 signups in 7 days, WAU 0, MAU 2**, newest signup 2026-08-08, newest sign-in 2026-08-14. The **roadmap accuracy gate is 30.1% HIGH/MEDIUM** (aggregate). Per the roadmap, 0 WAU is the *correct* state under a deliberately-unpromoted product — but it confirms demand has not moved.
- The reframe holds: the work is acquisition and accuracy, not instrumentation. The assets are built and idle: 30 `/insights` boards (both chain-two boards live), OG cards on every share surface, a working concierge with a real outcome-monitor, live alert loops.

Suggested next step: keep the accuracy gate climbing (dust-filter sale-floor decision, FMV confidence share), then pick **one** acquisition channel and run it against the 50+ WAU gate. Still the single most important item in the whole report.

### 2.2 Public intelligence surfaces — 30 public — `Severity: n/a (shipped) · context`

All 30 built surface dirs in `app/insights/` are public; the two chain-two boards read their data directly and carry their mandatory honesty disclosures (Candy's LOW-confidence FMV; Panini's listing-gated "floor, not a census" banner + `meta.coverage`). **This week's run-3 work hardened panel-level honesty specifically:** candy-mlb's six panels now consume `degraded` and render no `0` badge on a failed read (R18), and the large public entity pages (`set`/`team`/`player`/`series`/`edition`) degrade per-section in-brand instead of returning an unbranded Next.js 500 (R19). **Carried risk:** the `deals`/insights refresher fails a large share of board-warm ticks under saturation, so some boards serve last-good snapshots (surfaced honestly with an age stamp).

### 2.3 Data-intelligence — a deep-audit correctness week — `Severity: Medium (green; operator items) · Effort: mixed`

**FMV HIGH/MEDIUM confidence share:** the aggregate roadmap gate reads **30.1%** (08-23 filing). Per-collection shares were **not** re-captured in `metrics-latest.json` this run (it was a DB/queue pass); last full read (08-17) was TS 52.8% / AllDay 24.5% / Candy 60% / Pinnacle 40.7% / Golazos 0.9% / UFC 0.0%.

**Fixed / shipped this week (mostly from Claude Code on Trevor's box):**

- **D12b — a dead table published as live market depth.** `/nba-top-shot/analytics` rendered a 99-day-old single `ts_listings` row as Top Shot order-book depth. `OrderBookCard` now has a retired-source branch *before* the failed/count tests, facts centralized in `lib/analytics/ts-listings-retired.ts`, with a ban-at-zero guard that walks `app/`+`components/`. Building it exposed the bigger **R42** systemic find.
- **R42 — a shared comment-stripper that blanked real source.** 24 guards migrated to `scripts/lib/strip-comments.mjs`; the recommended lift was itself found blind (no regex-literal state, 80 occurrences) and corrected. Re-measured exposure was **103,590 chars across 49 product files**; 32 hydration-site casualties fixed.
- **R18 / R19 honesty panels** (candy-mlb six-panel + five entity pages) — see §2.2.
- **R22 — cross-collection mats 136.5h stale under a "REBUILT DAILY" label** — lock-window rewrite (build into temp table, TRUNCATE immediately before a tiny insert), schedules moved out of the degraded band; age dropped to minutes.
- **R23 — `funnel_events` was ~100% machine traffic with no bot flag** — server-side `bot_ua` + human-only partial index shipped.

**Regressed / re-measured worse:**

- **#8 — the sports-proxy `403` is now MEASURED DEAD as a "proxy ESPN" fix.** The 08-17 result ("ESPN 200 residential, 403 from Supabase edge ⇒ route it through a Worker") was a dated sample and **expired** — re-measured 08-22 from Trevor's box, ESPN **403s residentially too** (Akamai "Access Denied"), so a Cloudflare Worker is just another datacenter egress. UA-refresh and 403-retry are measured useless. The failure-rate alarm **exists** (`get_pipeline_alerts_core()`, 100% fail) and is **deliberately suppressed until 2026-10-14** — a sound decision (predicate: `all_upstreams_failed`, i.e. every upstream unreachable, not a code fault). Impact for projections is deferred to preseason (~Oct); the `nba_players` catalogue stays slate-gated-stale until then. **Operator-only, and the only cheap unrun experiment is a fetch from a *different* residential network.**

**Open / owed:**

- **R6 — `get_collection_stats` timeout on Top Shot's landing.** Re-measured in-band 08-23 but the band was NOT saturated (1 of 5 timed out, not 4 of 5), so the owed measurement is **still open** — its exit condition must be re-worded to name **saturation**, not the clock. Structural find (no timing): the per-edition lateral is computed **twice per request**. Real fix is R52's precomputed latest-FMV-per-edition.
- **#28 — `/sitemap/3.xml` truncates on a statement timeout and serves the partial set under a 200** (24,000 of 27,246 editions), and pages on `updated_at` which is 72% ties. The house "failed read renders as a fact" class, applied to a sitemap. `paginated-range-requires-order-ratchet` is green on it because it asserts `.order()` presence, not key uniqueness. **OPEN — the honesty canon's #28.**
- **FMV dust-filter *sale-floor* decision** (`docs/fmv-dust-filter-decision-2026-08-02.md`) — ANALYSIS ONLY, hand-off-only. FMV logic is Trevor's call.

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (green; 1 operator P0) · Effort: landed`

- **Security posture GREEN.** `metrics-latest.json`: **0/0/0/0** — invariants, anon-write holes, rls-off base tables, secdef-anon drift all empty (re-verified live).
- **#26/R44 — an 8-day `/api/ready` 500 was actually a privilege LEAK being closed.** `/api/ready` (anon-reachable) spread the full `health_check()` payload — user counts, saved-wallet counts, allow-list size, telemetry, `db_size_mb` — to unauthenticated callers until 2026-08-15, when a revoke correctly cut anon EXECUTE. The route now re-points at a cheap INVOKER `readiness_collection_stats()`; **the revoke stays.** ⚠ The route still **flaps 200/500 with the saturation band** (a different, open problem) — "verified live" earlier meant "verified calm".
- **🚨 #22 — the 2026-08-03 credential purge was DEFEATED (operator, needs Trevor).** `origin/claude/todo-implementation-e4tib3` branches from the ROOT commit, was never rewritten, and still carries the pre-purge blob on the **public** repo (present 2026-08-22 19:36 PT). Bounded to one branch; the honest "ahead" figure is **one** draft commit (`ee94c8a2a`). Ordered operator fix: triage that commit → delete the branch **via the GitHub UI** (remote delete-ref 403s from the sandbox) → ask GitHub to GC → **rotate regardless**.
- **#21 / #23 — edge-function drift (operator).** `edge-fn-drift.yml` was **red for 14 consecutive runs** — *loudly correct*, not broken: **25 deployed edge functions run a pre-import-map build that is not `main`** (set shrinking, 30→25, nothing new drifted). **5 of 25 are now on the import map** (canary `ufc-stub-thumbnail-resolver` verified live + 4 more). Separately, **29 of 67 deployed functions have NO committed source** (R21), and both credential guards derive their file set from `supabase/functions/**`, so 43% of the fleet is outside them by construction. Redeploy the remaining 24 with **both** `deno.json` in `files` **and** `import_map_path` (omitting the map turns stale-but-working into hard-down) — operator, off-limits classes included.
- **#24 — 6 live-drifted DB pins RESOLVED.** `db-pin-staleness.yml` was red for 13 runs; all six re-pinned *with assertion review* (not a mechanical repoint), verified live green **189/189 clean** on 2026-08-23 — the sweep's first green since 08-09. The transferable finding: not one of the six was uniform "rot" — a mislabeled feature add, a PROCEDURE the checker couldn't parse, a sargability rewrite that looked like a pricing defect until a positive control refuted it, etc.
- **#25 — nothing read the GitHub Actions instruments** (which is why #23/#24 sat red for two weeks). A **Detector-Health sentinel arm** now reads the last 12 runs of the three watched workflows and keys on a failure STREAK (warn ≥3, critical ≥7) — **built and merged, inactive until `GITHUB_ACTIONS_READ_TOKEN` is set in Vercel env** (operator).
- **DB-invariant SQL layer grew 180 → 189 pins** (181 `supabase/tests/*.sql` files). CI is **10 blocking jobs** (added `tree-corruption`). Coverage ratchets unchanged from last week's raise (primary 91.3/78.6/93.1/93.4; component 90.3/81.6/89.1/93.2; worker 85.1/72.1/83.8/88.1). **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low · Effort: ongoing`

The cloud pass is queue-only when it cannot push (this run). **Hygiene state:** (1) `docs/overnight/focus.md` is **now current** (dated 2026-08-17, no longer 54 days stale — a fix since last report); (2) `docs/overnight/ledger.md` holds **1,916** entries (was 1,618); (3) **~200 consumed inbox files remain un-archived** pending a push-capable pass (each cloud pass re-clones from origin, so archiving churns without effect). ⚠ **Sentry has been DARK since 2026-08-18** — "0 new issues" may be instrument-silence, not proof of no errors; queued (needs config/route work, NO-PUSH-blocked).

### 2.6 Overnight operational queue — `Severity: Low–Medium · Effort: mixed`

Health is GREEN-with-known-saturation-noise. The two trust breaches at capture are structural. Open items:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **NO-PUSH git credential (cloud)** | The cloud clone's `remote.origin.pushurl` has no credential → `git push` = "could not read Username" → **no overnight code deploys from the cloud pass, no inbox archival.** Trevor's box + Claude Code push fine. | **Med (operator)** | Re-embed the PAT in the mounted pushurl, or restore cloud credential injection. |
| **R46 structural saturation (DECIDED)** | 8,227 GB read in 10d18h, `dealloc=0`, ≈4.5 backends busy at all times on 2 cores. Trevor decided 2026-08-23: **no capacity change, permanently.** | Med (structural) | Root cause of fmv-recalc 52.9% kill, board-MV timeouts, #28, #30. Fix expensive queries / precompute; do NOT upgrade the tier. |
| **#30 topshot-active-listings-ingest** | DEGRADED, not dead. 29/40 GHA runs die at `?phase=targets` on a **DB statement timeout** before Atlas is touched (`topshot_serial_board_targets`: 57 calls, mean 13.2s, max 29.9s vs service_role's 30s ceiling, ~6.2 GB buffer touches/call). Its working arm is a **Windows Scheduled Task on Trevor's box** (the eighth caller source). | Med | Wants R52's precomputed latest-FMV-per-edition. #20's `wrangler deploy` fixes only 9/40. |
| **#28 /sitemap/3.xml truncation** | Serves 24,000/27,246 editions under a 200 on a statement timeout; pages on a 72%-tie key. | Med | The house honesty defect class. Throw or carry `complete:false`. |
| **fmv-recalc 52.9% kill rate** | Over half of every invocation killed at `maxDuration` under saturation. | Med | Lever is page size per invocation, NOT raising `maxDuration`. An R46 symptom. |
| **board-MV cron timeouts (#27)** | Three board MVs (deals/panini-squeeze/first-mint) carry a 600s `statement_timeout`; `rpc-refresh-panini-squeeze` burned the full 600s and rolled back. | Med (operator, one statement) | Re-run `cron.schedule` for jobs 352/353/354 at `'300s'`. Honest freshness stamp means it's a waste item, not a lying surface. |
| **#29 allday-pack-opens-backfill** | Writes on ~1 tick in 10 (9.9%); pg_cron calls every dispatch a success. Failures are upstream + connection-pool. | Low (downgraded) | Read `net._http_response` + the outcome table, never the scheduler self-report. |
| **#8 sports-proxy 403** | ESPN/NBA/DK all 403; proxy-ESPN measured dead; alarm suppressed to 2026-10-14. | Med (operator, deferred) | Do NOT retire (sole writer for `nba_players`/projections). |

### 2.7 Pack EV / pack-viz — `Severity: Low (honest by construction) · Effort: landed`

Carried. Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. `get_pack_detail_bundle` was one of the six re-pinned DB functions this week (#24) — its future-dated-snapshot guard is now asserted so clock skew surfaces as a red test rather than a wrong hero image on a public pack page. The `compute-*-pack-ev` edge functions are in the #23 drifted set (operator-gated redeploy).

### 2.8 Chain foundation — abstraction closed; BOTH expansions PUBLIC — `Severity: Low (shipped) · Effort: landed`

- **Chain-abstraction Phases A–F complete;** all re-export shims deleted 07-25. New code imports canonical `@/lib/chains/flow/...` only.
- **Candy / Solana — PUBLIC since 2026-07-31** (`CANDY_MLB_PUBLIC = true`, verified). Rollback = flag flip.
- **Panini — PUBLIC since 2026-08-01** (`PANINI_PUBLIC = true`, verified). Listing-gated coverage disclosure travels with the surface. Rollback = flag flip. The `panini_squeeze` board cutover this week took `public_board_liveness_sweep` to 45/45 (was 0/45).
- **17 Cloudflare worker dirs** (verified); `atlas-proxy` (#20) remains **INERT** pending operator deploy + egress probe — and now known to fix only 9/40 of #30's failures.

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** (2026-08-01) — verified this run: `lib/cart/`, `lib/trade-escrow/`, `app/dashboard/{trade-hub,gift}/` all **absent**. Inert Cadence templates kept as data; DB tables untouched. The product is purely read-only.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`; "D…"/"R…" = the deep-audit register. **§9 has the verified open/resolved status of every numbered item.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** Public + self-serve ~5.5 weeks; **re-measured 0 WAU / 21 users / 0 signups-7d (2026-08-23)**. Accuracy gate 30.1%. The gap is demand, not measurement. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| 0 | **Wallet verification.** RESOLVED BY REMOVAL (2026-08-08): no wallet sign-in on any surface; the listing challenge is the only self-serve path. | Low | (resolved-by-removal) |

### Deep-audit register — open / owed findings (run 3, 2026-08-22)

| id | Issue | Severity | Owner |
|---|---|---|---|
| **R46** | **Saturation is STRUCTURAL** — 8,227 GB / 10.75d, ≈4.5 backends busy on 2 cores. Trevor decided 2026-08-23: no capacity change. Root cause of a long tail of pipeline failures. | **decided (not a fix)** | Trevor (accepted) / Claude Code (cut queries) |
| R52 | Precomputed latest-FMV-per-edition materialization — the standing fix for R6 (`get_collection_stats`) and now #30 (`topshot_serial_board_targets`). A standing decision, not yet shipped. | P1 | Claude Code + Trevor |
| R6 | `get_collection_stats` times out on Top Shot's landing; per-edition lateral computed twice per request. Owed measurement re-worded: re-test **during saturation**, not just in-band. | P1 (partly refuted) | Claude Code |
| R21 | 29 of 67 deployed edge functions have NO committed source; 21 of them `verify_jwt:false`. Both credential guards derive their set from `supabase/functions/**`, so 43% of the fleet is unaudited by construction. The 29 are now enumerated as a baseline. | P1 | Claude Code + operator |
| R45 | Golazos offers Series 2/3 filters can only return nothing — verified 575/0/0. **Do NOT delete the rows** (both instruments read the same contract, blind to a second by construction). | P2 | Claude Code |
| D37 | AllDay `unmapped_sales` backlog — `unmapped_resolution_backlog_max=361` (~47k actionable, ~1047d). Ingest-capacity call. | P2 | Claude Code |

### Data-intelligence correctness / honesty

| Item | Issue | Severity | Effort |
|---|---|---|---|
| FMV confidence | Aggregate accuracy gate 30.1% HIGH/MED (08-23). Roadmap "AllDay → TS band" still OPEN. | Medium | Ongoing |
| #28 sitemap truncation | Serves 24,000/27,246 under a 200; pages on a 72%-tie key. House honesty defect class. | Medium (open) | Small–Medium |
| FMV dust-filter | `$0.50` sale floor inflates ~46% TS / ~76% AllDay editions. **Decision doc queued — hand-off-only, Trevor's call.** | Medium | Small (decision) / medium (unwind) |
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine primary. Legacy `edition_key` is character-LOSSY — never repoint character reads onto it. | Medium | Medium |

### Cost / operational right-sizing

| Item | Issue | Severity | Effort |
|---|---|---|---|
| DB storage | **13,848 MB — UP ~734 MB** this week. | Low–Med | Small (monitor) |
| Disk-IO saturation (R46) | **STRUCTURAL and DECIDED** — drives fmv-recalc kill rate, board-MV timeouts, #28, #30. Fix expensive queries / precompute; the tier is NOT the lever. | Medium | Ongoing |
| Vercel cost family | Carried (Spend-Management cap backstop; Fluid/cron/observability levers). | Medium | Small–Medium |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | CLOSED — all shims deleted 07-25. | n/a (resolved) | (landed) |
| Candy / Panini | Both PUBLIC (07-31 / 08-01). Rollback = flag flip. | n/a (shipped) | (landed) |
| `atlas-proxy` (#20) | Shipped but INERT — pending operator `wrangler deploy` + egress probe. Fixes only 9/40 of #30. | Low | Small (operator) |

### Instruments / edge-function drift

| # | Issue | Severity | Effort |
|---|---|---|---|
| 21 | `topshot-moments-hydrator`'s cron is declared in NO repo file; a `wrangler deploy` would DELETE it. Operator: codify the trigger in `wrangler.toml`, read the worker's Cloudflare logs. | Med (operator) | Small |
| 23 | 25 edge functions running a pre-import-map build ≠ `main`; edge-fn-drift red 14 runs. 5 of 25 now on the import map. Operator: redeploy the remaining 24 with both flags. | Med (operator) | Medium |
| 25 | Detector-Health sentinel arm built + merged; **inactive until `GITHUB_ACTIONS_READ_TOKEN` set in Vercel env.** | Low (operator) | Trivial (one env var) |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 | Monolith page refactor — Phase 1 complete; pages are thin `page.tsx` + `*Client.tsx`. Bulk lives in CollectionTabClient **1,347** / SniperClient **1,804** / CollectionAnalyticsClient **1,840** / DashboardClient **2,613** (measured this run). Phase-2 component splits remain (medium-risk, needs rendered-DOM validation). Plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (Phase-2 remains) |
| 10 | `/dashboard` token migration — logic in `DashboardClient.tsx` (**2,613** lines). | Low | Large |
| 15 | `livetoken-portfolio*.json` scratch fixtures — RESOLVED (none git-tracked). | Low (resolved) | Trivial |

### Page polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack/Moment/Set tune-up. Deep-audit run 3 swept more entity honesty (R19 per-section degrade across 5 pages). Remaining lower-value tier: modal a11y, Set B5/B7, the deferred `/ufc-strike/*`→`/ufc/*` 301. Audit docs are point-in-time. | Low–Medium | Medium (mostly done) |
| 11 | Brand punch list — partial. Per-feature OG cards exist; still missing `/home-fmv-preview.png`. CI guard `scripts/check-brand-tokens.mjs` (present). | Low | Small |
| 12 | Blazers trivia — **CLOSED 2026-08-17**: the cited `lib/blazers-trivia.ts` does not exist (verified ABSENT this run); the 29 items survive in git history. Do not re-open without confirming the file exists. | Low (closed) | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 / #3 / #3b | Cart / Trade Hub / Gifting — DELETED (2026-08-01), verified still absent. | n/a (removed) | n/a |
| — | Breaks — dormant (tables not in prod, migration unapplied). | Low (dormant) | n/a |

### Deferred hardening (intentional — from `docs/reference/known-issues.md`)

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each retain a `roles=public` INSERT policy. Future hardening: per-row size caps, a `created_at` rate-limit trigger, a `bot_score` column, possibly an edge rate-limiter.
- `user_achievements` + `watchlist_items` — service-role-only writes but still keyed on `owner_key` (text) rather than `user_id` (UUID).
- `badge_editions.low_ask` — AllDay + Golazos RESOLVED. Golazos `highest_offer` gap is **SETTLED**: there is no Golazos offer source at all (0 DapperOffersV2 offers of either type; cause is demand, not plumbing). **Do NOT schedule the staged offers indexer** — it would index nothing.

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design (long-form vs short-form; `HIGH|MEDIUM|LOW` vs `HIGH|MED|LOW`). Re-read `CLAUDE.md` before writing any new query. `docs/reference/schema-truth.md` (present) is authoritative for volatile schema facts.
- **Supabase compute is `SMALL` (2 GB / 2-core)** — saturation is disk-IO-budget-bound and now formally STRUCTURAL (R46).
- **A function-level `SET statement_timeout` is INERT** — the binding budget is the caller's role, not the declaration. Proven live twice this week (cross-collection step1 ran ~470s under a declared 180s).
- **The eighth caller source is real:** a Windows Scheduled Task on Trevor's box runs four production ingests (Deal Board, Pinnacle Render Cache Fill, Panini, AllDay Badge) — invisible to all six repo sources plus cron-job.org. Enumerate it before calling any ingest dead.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old two-item list is replaced by **`docs/strategy/roadmap-2026-08-03.md`** (verified present, stamped 2026-08-23), canonical (supersedes 07-18):

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM confidence share must beat the sites collectors already use before growth tactics return.** | Advancing — aggregate gate 30.1%; dust-filter sale-floor decision still queued. |
| 1 | **Prove the product with real users — the only user gate is 50+ WAU.** | **Open — the critical path.** Instrumentation done; **re-measured 0 WAU (2026-08-23)** (§2.1). |
| 2 | Cost / latency levers. | Advancing but bounded — saturation is now STRUCTURAL and DECIDED (R46); the lever is cutting queries, not capacity. DB +734 MB. |
| 3 | Durable debt. | **Heavy advance** — deep-audit run 3 drain; 6 DB pins re-pinned (189/189); GHA detector-health arm; edge-fn drift 30→25. |
| 4 | Chain two, readiness-gated. | **DONE — both boards PUBLIC** (Candy 07-31, Panini 08-01). |

**Standing guardrails:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (now eight sources, including Trevor's box Task Scheduler).

**Housekeeping still outstanding:** activate the GHA detector-health arm (#25, one env var); redeploy the remaining 24 drifted edge functions (#23); action the credential-purge cleanup (#22).

---

## 5. In-code TODO inventory

A first-hand `ripgrep` scan over `app/ lib/ components/ workers/ supabase/functions/ scripts/ docs/drafts/ proxy.ts` (node_modules/.next/.git excluded) found **no actionable markers in live application code** — unchanged in character from prior weeks. Breakdown:

### 5a. Candy launch-flag-gated "note" branches (2 markers) — keep by design

- `app/api/candy-sales-indexer/route.ts:160` and `app/api/ingest/candy-editions/route.ts:182` — `note: "…still a TODO_-prefixed placeholder"` strings inside launch-flag-gated defensive branches. Constants are filled; branches unreachable in practice. Not actionable.

### 5b. Solana readiness-guard refs (6 markers) — guard functions, not open work

- `lib/chains/solana/normalize.ts` — the `startsWith("TODO_")` readiness-guard functions + their `TODO_n RESOLVED` narrative. Placeholder-guards, not open TODOs.

### 5c. Panini draft/reference lines — draft-only, all closed

- `docs/drafts/panini/ingest-panini-runner.mjs` (×3, all `TODO(go-live) RESOLVED 2026-07-16/19`), `docs/drafts/panini/panini-proxy/index.js:19` (`TODO(discovery) CLOSED 2026-07-19`), and two panini-methodology/buildkit references — all annotated resolved/closed draft scaffolding.

### 5d. Narrative / false positives (rest)

- **~4 narrative/false-positive lines:** `lib/rtr-lock-roi-weights.ts:7` + `app/api/rtr/lock-roi/route.ts:38` ("resolves the standing … TODO" / "v2 folds in the two signals the v1 TODO called out"), `lib/format.ts:6` (`"$X,XXX.XX"` format doc), `lib/chains/solana/normalize.ts:46` (placeholder narrative), and a migration comment (`supabase/migrations/20260713050000_…:4` "was a TODO in `CollectionMomentTable.tsx`"). All describe *resolved* work.
- ⚠ **Method note:** a whole-repo `rg` with negated globs times out on the large SQL corpus (documented in prior reports); scoped per-directory scans returned promptly and are the basis here. The `workers/pack-events-ingest/node_modules/` tree contains vendored TODO markers (`@supabase/auth-js`, `@speed-highlight/core`) — excluded as third-party, not RPC code.

> **Net change since last week:** none of consequence. Live application code has zero actionable TODO markers.

---

## 6. Resolved / no action needed

Verified against the codebase, `docs/reference/known-issues.md`, `docs/audits/deep-audit-register.md`, and `docs/overnight/metrics-latest.json`:

**Known-issue slate (carried, still resolved):** #0 (wallet verification, resolved-by-removal), #2 (Sentry SDK wired — but see the dark-since-08-18 caveat), #3 (Flowty), #4 (Pinnacle FMV + ASK_ONLY drop), #5, #6, #7, #9, #12 (closed — file absent), #13, #15, #16, plus the fmv-recalc silent stall. ⚠ **#8 remains REGRESSED** — see §2.3/§9.

**Newly resolved / closed / shipped this week (mostly from Claude Code on Trevor's box):**
- **#19 pg_cron ownership block** — jobid 70 (`rpc-refresh-misattrib-candidates`) moved to 23:35Z via migration `20260822215445`; first run 36.4s (16.5× under the 600s wall) and the MV refreshed to 20,516 rows. (One sample — not fully closed on a single good run.)
- **#24 six live-drifted DB pins** — all re-pinned *with assertion review*, verified live green **189/189** on 2026-08-23.
- **#26/R44 `/api/ready` privilege leak** — anon EXECUTE on `health_check()` revoked; route re-pointed at cheap INVOKER `readiness_collection_stats()`. (Route still flaps with saturation — a separate open item.)
- **#25 Detector-Health sentinel arm** — built + merged (inactive pending one env var).
- **Deep-audit run 3 P1 batch** — D12b (dead-table order-book), R42 (shared comment-stripper), R18 (candy-mlb panels), R19 (5 entity pages degrade in-brand), R22 (cross-collection mats staleness), R23 (`funnel_events` bot flag). R20/R43's generalizations correctly **refuted** rather than actioned.
- **DB-invariant pins 180 → 189; CI 9 → 10 jobs** (`tree-corruption`); `focus.md` refreshed (was 54 days stale).

---

## 7. Suggested sequence

A pragmatic order under the **accuracy-is-the-gate** framing (`docs/strategy/roadmap-2026-08-03.md`):

1. **Action the standing operator items — Trevor.** (a) **Clean up the defeated credential purge (#22)** — triage `ee94c8a2a`, delete `claude/todo-implementation-e4tib3` via the GitHub UI, ask GitHub to GC, rotate regardless. (b) **Set `GITHUB_ACTIONS_READ_TOKEN`** to activate the detector-health arm (#25) — one env var closes the "nobody reads the GHA instruments" gap. (c) **Re-run `cron.schedule` for jobs 352/353/354 at `'300s'`** (#27).
2. **Restore the cloud git push credential (§2.6) — operator.** Blocks the autonomous pass's code shipping + inbox archival. Trevor's box + Claude Code are unaffected.
3. **Drive traffic against the 50+ WAU gate (§2.1).** Re-measured 0 WAU; accuracy gate 30.1%. Keep the accuracy gate climbing, pick one channel. Still unambiguously the top product item.
4. **Ship R52's precomputed latest-FMV-per-edition (§2.3/§2.6).** One materialization fixes R6 (`get_collection_stats`) AND #30 (`topshot_serial_board_targets`), the two heaviest reads left. The most leverage available against the *decided* R46 saturation.
5. **Close #28 (sitemap truncation) and re-word R6's exit condition to name saturation.** The sitemap is the live instance of the house honesty defect; R6 needs a saturation-band re-measure, not a quiet-window one.
6. **Redeploy the remaining 24 drifted edge functions (#23) with both flags** — operator, off-limits classes included; confirm the next 06:40Z census goes green.
7. **Put the FMV dust-filter *sale-floor* decision in front of Trevor (§2.3).** Highest-leverage accuracy-gate correctness change still queued; hand-off-only.
8. **Deep-audit tails as capacity allows** — R21 (29 uncommitted edge fns), D37 (AllDay unmapped tail), #29 (allday-pack-opens rate). Archive the ~200 consumed inbox files once a push-capable pass runs.

---

## 8. Notes from verification

- **Shell GREEN this run.** Commit counts, line counts, path checks, and the TODO scan are all first-hand (`git log`, `ripgrep`, `wc -l`, `ls`). ⚠ **git PUSH is dead** in the cloud sandbox (missing pushurl credential) — Trevor's box + Claude Code push fine and did most of this week's shipping.
- **Commits measured:** `git log --since=2026-08-17` = **~690** (143/47/0/51/55/286/107/1 across Aug 17–24). HEAD `8ee00825` (2026-08-23 22:46 PT, a ledger commit).
- **TODO scan: 0 actionable markers in live app code** (§5) — measured via `ripgrep` over the source tree; `workers/**/node_modules` vendored markers excluded.
- **Deletions verified by absence:** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift` — all absent. **`lib/blazers-trivia.ts` verified ABSENT** (slot #12 now correctly CLOSED, not re-cited — a fix since last report).
- **Launch flags verified in `lib/launch-flags.ts`:** `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`.
- **Counts measured this run:** CI = **10** jobs (`.github/workflows/ci.yml`, added `tree-corruption`); DB pins = **189** (`supabase/tests/*.sql` = 181); Vercel crons = **38** (`vercel.json`); worker dirs = **17**; edge functions = **40** (`supabase/functions/`); `app/insights/*` dirs = **30**; `app/**/page.tsx` = **119**; `app/api/**/route.ts` = **454**; `lib/**/*.ts` = **305**; `components/**/*.tsx` = **156**; monolith client files 1,347 / 1,804 / 1,840 / 2,613.
- **Cited paths spot-checked — all resolve:** `docs/strategy/roadmap-2026-08-03.md`, `docs/reference/known-issues.md`, `docs/reference/schema-truth.md`, `docs/audits/deep-audit-register.md`, `docs/audits/deep-audit-2026-08-22.md`, `docs/fmv-dust-filter-decision-2026-08-02.md`, `docs/audits/refactor-plan-monolith-pages-2026-05.md`, `scripts/check-brand-tokens.mjs`, `docs/handoff-2026-08-09e-edge-gate-key-rotation.md`, `lib/launch-flags.ts`. **Absent (correctly):** `lib/blazers-trivia.ts`, `lib/cart`, `lib/trade-escrow`, `app/dashboard/{trade-hub,gift}`, `docs/FREEZE.md` (→ no active freeze).
- **`docs/overnight/focus.md` is current** (dated 2026-08-17, no longer stale). `docs/overnight/ledger.md` has **1,916** `### ` entries (was 1,618). `docs/overnight/inbox/` holds **225 files**; `INDEX.md` asserts **224 live filings**.
- **DB-side facts** (DB size **13,848 MB**, editions **27,246**, security 0/0/0/0, 2 trust breaches, pipeline failure rates) come from **`docs/overnight/metrics-latest.json` (2026-08-24T08:12Z — same day, real-time from DB)** plus the 08-22/23/24 known-issues + ledger entries. **Traction RE-CAPTURED this run: 21 users / 0 WAU / 0 signups-7d** (08-23 filing), accuracy gate **30.1%**. **Sentry dark since 08-18** — "0 new" may be instrument-silence.
- **Deep-audit register reconciliation:** run 3 (2026-08-22) is the latest pass; it found 11 register OPEN items already fixed inside 134 commits its clone was behind, and closed R18/R22/R23/R42/R43/D12b same-day. This report treats those as resolved and R6/R21/R45/R46/R52 as open/owed per the register.
- **Autonomous-task caveat:** the daytime monitor + night pass run against this repo, and Claude Code pushed heavily from Trevor's box this week, so the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` + `docs/audits/deep-audit-register.md` are the authoritative records.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-08-24)

Every slot from `docs/reference/known-issues.md`, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | Register status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | Resolved-by-removal | **Resolved-by-removal** — listing-challenge is the only self-serve path | `resolve_wallet_challenge_match` present |
| 1 | Cart execution | DELETED | **Removed from the tree (08-01)** | `lib/cart/` absent |
| 2 | Sentry inactive | Resolved | **Resolved — but DARK since 08-18** (instrument silence caveat) | metrics `sentry_caveat` |
| 3 | Flowty / Trade Hub | Resolved + DELETED | **Flowty resolved; Trade Hub deleted; contract + suite kept in CI** | `lib/trade-escrow/` absent |
| 3b | Gifting | Removed | **Removed from the frontend (08-01)** | `app/dashboard/gift/` absent |
| 4 | Pinnacle FMV | Resolved (+ ASK_ONLY drop fixed 08-16) | **Resolved** | `pinnacle_fmv_recalc_render_all.sql` pin |
| 5 | AllDay/UFC mis-categorized | Resolved | **Resolved** — only 8 stray | register |
| 6 | WarmupContext key | Resolved | **Resolved** | `lib/warmup/WarmupContext.tsx` |
| 7 | AllDay `unmapped_sales` | Resolved | **Resolved (original defect)** — current 361/47k is expected residue (D37) | metrics + D37 |
| 8 | NBA stats / sports-proxy 403 | **REGRESSED** | **REGRESSED, re-measured WORSE** — ESPN 403s residentially; proxy-ESPN dead; alarm suppressed to 2026-10-14 | known-issues #8 |
| 9 | Storefront audit pipeline | Retired | **Retired** | prior runs |
| 10 | `/dashboard` token migration | Open | **Open** — logic in `DashboardClient.tsx` (2,613 lines) | this run |
| 11 | Brand punch list | Open (partial) | **Open — much improved** | `scripts/check-brand-tokens.mjs` present |
| 12 | Blazers trivia | **CLOSED 08-17** | **Closed — file ABSENT, slot no longer re-cites it** | `find **/blazers*` → none |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | register |
| 14 | Monolith page refactor | Phase 1 complete | **Open — Phase 2 remains**; bulk in Client files (1.3k–2.6k lines) | measured this run |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** | prior runs |
| 16 | `flow test` in CI | Resolved | **Resolved — expanded to 10 jobs** (added `tree-corruption`) | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set tune-up | Open (ongoing) | **Open — R19 entity-page sweep continued** (5 pages degrade in-brand) | register R19 |
| 18 | Deep audit run 2 findings | Open | **Largely drained** — superseded by run 3 (08-22) | register |
| **19** | pg_cron `cron_heavy` ownership block | **RESOLVED 08-22** | **Resolved** — jobid 70 moved to 23:35Z via migration; first run 16.5× under wall | known-issues #19 |
| **20** | `atlas-proxy` egress | Open (operator) | **Open — re-measured**: fixes only 9/40 of #30; 29 die earlier on a DB timeout | known-issues #20/#30 |
| **21** | `topshot-moments-hydrator` cron undeclared | Open (operator) | **Open** — a `wrangler deploy` would DELETE its dashboard cron | known-issues #21 |
| **22** | 🚨 Credential purge DEFEATED (public branch) | Open (Trevor) | **Open — SECURITY** — pre-purge blob still fetchable (present 08-22 19:36 PT) | known-issues #22 |
| **23** | 25 edge fns running non-`main` build | Open (operator) | **Open — 5 of 25 now on import map**; set shrinking 30→25 | known-issues #23 |
| **24** | 6 live-drifted DB pins | **RESOLVED 08-22/23** | **Resolved** — all re-pinned + assertion-reviewed, live green 189/189 | known-issues #24 |
| **25** | Nothing reads GHA instruments | Arm shipped, inactive | **Open (one env var)** — detector-health sentinel arm merged, needs `GITHUB_ACTIONS_READ_TOKEN` | known-issues #25 |
| **26** | `/api/ready` 500 for 8 days | **Partly resolved** | **Privilege leak REVOKED; route still FLAPS with saturation band** | known-issues #26/R44 |
| **27** | 3 board-MV crons carry 600s timeout | Open (operator) | **Open** — one `cron.schedule` statement per job at `'300s'` | known-issues #27 |
| **28** | 🔴 `/sitemap/3.xml` truncates under 200 | Open | **Open** — 24,000/27,246 editions; house honesty defect class | known-issues #28 |
| **29** | `allday-pack-opens-backfill` writes ~1/10 | Open (downgraded) | **Open** — rate is real (9.9%); failures upstream + pool | known-issues #29 |
| **30** | 🔴 `topshot-active-listings-ingest` DB-timeout | Open (corrected) | **Open — DEGRADED not dead**; second caller = Windows Task on Trevor's box (8th source) | known-issues #30 |

**Tally:** ~14 resolved/closed (#0, #2, #3, #4, #5, #6, #7, #12, #13, #15, #16, #19, #24, fmv-recalc stall) · **1 regressed/re-measured-worse (#8)** · 3 removed by decision (#1, #3, #3b) · 1 retired (#9) · **~11 open/partial** (#10, #11, #14, #17, #20, #21, #22, #23, #25, #26, #27, #28, #29, #30). Plus the live **deep-audit register** (run 3, 2026-08-22 — R6/R21/R45/R46/R52 open/owed), the **30.1% accuracy gate**, **Candy + Panini public boards**, **10-job CI**, **189 DB-invariant pins**, and the **30 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** the register grew from `#0–#18` to `#0–#30` this week, and the character of the growth is *instruments that were quietly lying* — a red-for-14-days edge-fn-drift check, six live-drifted DB pins, an 8-day `/api/ready` 500 that was really a privilege leak, a sitemap serving a truncated set under a 200 — most of which were resolved or correctly triaged rather than left to rot. The saturation that drives half the operational queue is now formally **structural and decided** (R46), which is a reframe as much as a finding: several "failing pipeline" items are symptoms of a constraint that will not be bought out of, so the lever is cutting queries (R52) not adding capacity. Two things genuinely need a human beyond the standing operator queue: **(1)** action the **defeated credential purge (#22)** — pre-purge secrets are still fetchable from the public repo — and **(2)** accept that the **sports-proxy 403 (#8)** re-measured worse and is deferred to preseason, with its alarm correctly suppressed to 2026-10-14. And the top-line framing is unchanged and now *measured* rather than presumed: with the site public and self-serve ~5.5 weeks, **WAU is 0 against a 50+ gate** — **demand is the one number that decides everything**, and it has not moved.
