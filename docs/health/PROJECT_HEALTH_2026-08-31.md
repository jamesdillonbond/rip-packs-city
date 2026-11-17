# Rip Packs City — Project Health Report

**Date:** 2026-08-31
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (Known issues §, Deferred hardening §; the register's own STATUS INDEX now counts **52 numbered items — 29 open · 5 partial · 18 closed**, current through the 2026-08-30 entries), `docs/reference/roadmap-status.md` (headline metric + demand re-read **2026-08-29 17:25 PT**), `docs/audits/deep-audit-register.md` + `docs/audits/deep-audit-2026-08-27.md` (**run 4, 2026-08-27**), `docs/overnight/metrics-latest.json` (captured **2026-08-31T08:10Z / 01:09 PT**, same day, genuine-overnight), `docs/overnight/focus.md` (dated 2026-08-17, steers appended through 08-26), `docs/overnight/ledger.md` (**1,394** live `### ` entries; pre-08-10 rolled to `ledger-archive-2026-H2.md`), `docs/overnight/inbox/` (**338 files; INDEX asserts 337 live**), plus a first-hand `git log` + `ripgrep` scan and file-existence verification (the workspace shell is **GREEN** this run).
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (now `#0–#54`), the deep-audit register (run 4), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-08-24.md` (7 days ago). This regeneration mirrors its structure. `_2026-08-17.md` … `_2026-05-22.md` (seventeen prior reports) also live in `docs/health/`.

> **✅ Tooling note — shell GREEN, git PUSH still dead in the cloud sandbox (unchanged cause).** Real `git`/`rg`/`wc` this run: measured commit counts, line counts, and a first-hand TODO scan. ⚠ **`git push --dry-run origin main` = `could not read Username for 'https://github.com'`** — the mounted clone carries no push credential, so autonomous **code deploys from the cloud Cowork session remain blocked**. This is scoped to the cloud sandbox: **Trevor's Windows box and Claude Code push normally**, and did essentially all of this week's ~808 commits. The 08-31 overnight pass shipped **0 to prod** for this reason — and honestly noted nothing net-new-and-safe remained to ship even with a push, since concurrent Claude Code sessions had already landed ~15 DB/perf fixes in the prior 24h.

> **⚠ Date nuance.** The harness stamps today as **2026-08-31**; the freshest metrics were captured **08:10Z = 01:09 PT Aug 31** (no clock skew — DB `now()` and shell agreed to the second). The freshest **traction/accuracy** read is **2026-08-29 17:25 PT** (`roadmap-status.md`); the nightly metrics run did not re-capture traction. Ledger/session dates in `CLAUDE.md` are Pacific. Filed under **2026-08-31** per the weekly-regeneration convention (prior report 08-24, exactly 7 days back).

> **Report location stays clean.** All eighteen reports (this one included) live in `docs/health/`; the repo root holds none.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/audits/deep-audit-register.md` for the deep-audit findings. This doc reorganizes all three for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-08-24 — accuracy climbed and demand ticked off zero, on a quiet-but-heavy correctness week shipped from Trevor's box.** Five threads. **(1) The accuracy gate moved up: estate-wide HIGH/MEDIUM confidence share is 34.9%** (was 30.1% last week), Top Shot alone **39.9%** — with a methodology note: on **2026-08-28 Trevor decided the Top Shot denominator is ALL rows, not canonical-only**, so the number is now stricter *and* higher. **(2) Demand came off the floor for the first time in the report's history: WAU = 2** (was 0), **23 accounts (+2)**, **104 saved wallets**, newest signup 2026-08-25 — still far below the 50+ WAU gate, but no longer flat-zero. **(3) Monthly deep-audit run 4 (2026-08-27) ran** — six parallel sweeps, register rewritten same commit — and the register grew from `#0–#30` to `#0–#54`, most of the new slots being pg_cron-waste and instrument-honesty findings (see §9). **(4) `#28` sitemap truncation, open last week, is now CLOSED** (code fix 08-23, verified in production against the DB 08-24). **(5) A ~38-hour Top Shot legacy-endpoint outage dominated 08-29/08-30 and has SELF-RECOVERED** — FMV staleness back to 0.1h, and the recovery refilled HIGH+MED Top Shot 6,983→8,001.

> **Overnight reality — GREEN-with-known-noise; NO-PUSH (cloud).** The 08-31 genuine-overnight pass (01:09 PT) shipped **0** — shell GREEN, cloud push credential missing, and nothing clearly-safe AND net-new remained. Security **0/0/0/0** (invariants, anon-write, rls-off, secdef-anon all clean). **One trust breach, structural and improving:** `unmapped_resolution_backlog_max = 265` (All Day ~47k actionable, ~531 days — a permanent floor; was 361 last week, trending down 295→275→265). Down from **2 breaches** last week. `rpc_ops_snapshot` healthy, no timeout. Post-ship watch over this week's concurrent Claude Code ships was **GREEN** (a 04:58Z fmv-backfill vacuum fix; a reindex wave that cut DB size 14,412→13,441 MB).

> **Traction reality — WAU off zero, still far under gate (re-read 2026-08-29 17:25 PT).** **23 accounts, WAU 2, 104 saved wallets**, newest signup 2026-08-25. The roadmap's accuracy gate — the share of prices at HIGH/MEDIUM confidence — stands at **34.9% estate-wide** (per-collection: Top Shot 39.9%, All Day 24.6%, Golazos 0.3%, UFC 0.0%, Candy 60.8%). The site has been public since 07-17 and self-serve since 07-20. **Demand is still the one number that decides everything** — 2 WAU against a 50+ gate — but this is the first weekly report in which it is not zero, and 104 saved wallets suggests some anonymous engagement the funnel is not converting to sign-ins. Per the roadmap, a low number is the *correct* output of a deliberately-unpromoted product.

> **Cost / storage — DOWN this week.** DB is **13,441 MB, −407 MB** over last week's 13,848, after a reindex wave + vacuums this run took it 14,412→13,441. **Disk-IO on the SMALL (2 GB / 2-core) Supabase instance remains the binding operational constraint and is STRUCTURAL** (the 08-23 decision holds: no capacity change). It is the direct cause of the pg_cron waste cluster surfaced by run 4 (`#40`–`#43`), the fmv-recalc kill rate, the board-MV timeouts (`#27`), and the chronic pipeline fail-rates. The documented lever is **fixing expensive queries and precomputing, NOT upgrading the tier** — and run 4 turned that into a concrete backlog: `#42` alone is **22.6% of all pg_cron time thrown away**, 85% of it statement timeouts driven by schedule alignment.

> **Platform context (unchanged).** **(1) Flowty** frontend shut but API ALIVE and feeding live ingest. **(2) NFL All Day** primary pack sales ended; secondary-market only. **(3) UFC Strike** Flow market frozen (0 sales; honestly labelled). **(4) Candy / Solana** — PUBLIC since 07-31. **(5) Panini** — PUBLIC since 08-01 (listing-gated coverage disclosed structurally). **(6) Expansions are readiness-gated, not sequence-gated.**

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md` — **1,394** live entries + two archives, `inbox/` — **338 files**, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` (absent this run → no freeze) halts all autonomous shipping. **Check `docs/overnight/ledger.md` and `docs/audits/deep-audit-register.md` before acting** — items below may move without a human in the loop, and much of this week's work landed from Claude Code on Trevor's box, not the cloud pass.


> ⛔⛔ **CORRECTION APPENDED 2026-08-31 ~03:25 PT (10:25Z) by the Claude Code session that committed this file (it was written NO-PUSH).** 🚨 **The claim "a ~38-hour Top Shot legacy-endpoint outage … has SELF-RECOVERED" is REFUTED. The host is still down.** Probed from Trevor's box (**residential** egress — the arm that *does* work for the Atlas ingest, so this is not the `egress_blocked` datacentre class): `POST public-api.nbatopshot.com/graphql` **×4 → 530, 530, 530, 530**, with a positive control `GET rippackscity.com/api/health` → **200**. ⭐ **The readings behind the claim are real; the ATTRIBUTION is not.** `topshot_fmv_stale_hours` 0.1 and HIGH+MED 6,983→8,001 both happened — but **FMV is sales-driven and Top Shot sales are on-chain** (`max(sold_at)` 16 min old), so that path never depended on the dead host. ⭐⭐ **The cleanest disproof needs no probe: `topshot-fmv-populate` is ITSELF still in the paused/suppressed cohort** — a metric cannot have recovered *because* a pipeline returned when that pipeline is still switched off. ⚠ **Consequence: 7 pipelines remain suppressed to 2026-09-13 on this host** (`compute-topshot-pack-ev`, `topshot-badge-catalog`, `topshot-badge-set-backfill`, `topshot-deal-floor-serials`, `topshot-fmv-populate`, `topshot-moments-hydrator`, `topshot-pack-pool-backfill`) **and all seven suppressions are CORRECT** — un-pausing them against a 530 host restores the exact failure they exist to silence. ⚠ **This is the THIRD artifact to carry the claim** (nightly handoff, its ledger entry, this report), all from the same proxy metric and none from a probe — CLAUDE.md's *"a plausible mechanism is not a measurement"*, with the host one request away. ⓘ The rest of this report stands; the **08-31T0610Z** daytime-monitor filing reached the right posture on the same signals by explicitly refusing to conclude. Full write-up: ledger 2026-08-31.
---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#54** | Register STATUS INDEX: **52 numbered items — 29 open · 5 partial · 18 closed**. Twenty-four new slots (#31–#54) since the 08-24 report's `#0–#30`. See §9. |
| Known issues — resolved/closed since last week | **~7** | **#28** (sitemap truncation — verified in prod), **#37** (React #418), **#44** (3 zero-yield UFC pipelines retired), **#45** (eslint ratchet driven to 1), **#46** (template-interpolation desync), **#53** (edge-fn eszip census), plus the #24/#19 batch already closed. — §6 / §9 |
| Known issues — open / partial | **~34** | 29 open + 5 partial per the index (e.g. #8, #10, #11, #14, #17, #20–23, #25, #27, #29–36, #38–43, #47–52, #54). — §3 / §9 |
| Known issues — 🚨 SECURITY, needs Trevor | **1** | **#22** — the 2026-08-03 credential purge remains DEFEATED by a stale ROOT-branch of the PUBLIC repo (`claude/todo-implementation-e4tib3`); pre-purge blob still fetchable. Triage `ee94c8a2a`, delete via GitHub UI, GC, rotate regardless. Unchanged since last week. — §2.4 |
| Known issues — instrument DARK, needs Trevor | **1** | **#34** — Sentry has accepted nothing since 2026-08-18 (org error quota exhausted). Trevor's call: no Sentry spend; mitigations shipped instead. Client-only errors remain captured by nothing but the E2E DOM smoke badge. — §2.5 |
| Known issues — regressed / measured-dead (carried) | **1** | **#8 sports-proxy 403** — still 0 ok (0/16 in 48h, `all_upstreams_failed`); "proxy ESPN" measured dead; alarm suppressed to 2026-10-14. Deferred to preseason (~Oct). — §2.3 |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot, 2026-08-01). Verified still absent. |
| **Deep-audit register (run 4, 2026-08-27)** | **run 4 ran** | Six parallel sweeps; register rewritten same commit. Surfaced/promoted the pg_cron-waste cluster (#40–#43) and the param-blind-plan class (#52). — §2.3 |
| Commits this week | **~808** | Measured (`git log --since 2026-08-24`): 132 (24th) · 87 (25th) · 103 (26th) · 75 (27th) · 117 (28th) · 169 (29th) · 123 (30th) · 2 (31st). Heavier than last week's ~690. HEAD `7ee060d4` (2026-08-31 03:02 PT, an edge-fn-drift report fix). |
| Accuracy gate (headline metric) | **34.9% estate-wide** | Up from 30.1% last week; TS 39.9% / AllDay 24.6% / Golazos 0.3% / UFC 0.0% / Candy 60.8% (08-29 read). ⚠ **Methodology change 08-28:** TS denominator is now ALL rows, not canonical-only — stricter and still up. |
| Demand (the critical-path number) | **WAU 2 · 23 accounts · 104 saved wallets** | Off zero for the first time in this report's history (was 0 WAU / 21 accounts). Newest signup 2026-08-25. Gate: **50+ WAU**. — §2.1 |
| Open overnight operational items | **~8 active + standing queue** | NO-PUSH (cloud); structural saturation (pg_cron waste #40–#43, fmv-recalc kill, board-MV timeouts #27); #47 candy-editions kills; #22 stale public branch (operator); #34 Sentry dark (operator); #8 sports-proxy 403 (operator, deferred ~Oct); #23/#25/#31 edge-fn-drift instrument (operator). — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana (PUBLIC) + Panini (PUBLIC); multi-chain abstraction Phases A–F complete. — §2.8 |
| Prioritized next actions | **superseded** | `docs/strategy/roadmap-2026-08-03.md` is canonical (accuracy-is-the-gate; stamped 2026-08-23, steers through 08-28). Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **0 actionable in live app code** (+2 candy launch-flag "note" branches by design, +6 solana readiness-guard refs, +draft-doc `RESOLVED`/`CLOSED` lines, +1 migration comment, +a few resolved-narrative false positives) | Measured via `ripgrep` — §5 |
| Test / DB-invariant pins | **181 `supabase/tests/*.sql` files** | Live pin count not re-run this pass (last green: 189/189 on 2026-08-23). File count unchanged from last week. |
| CI blocking jobs | **12** | Added **`eslint-ratchet`** + **`register-guard`** (was 10): `typecheck`, `eslint-ratchet`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests`, `component-tests`, `worker-tests`, `db-tests`, `ledger-guard`, `register-guard`, `tree-corruption`, `edge-deno`. |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** A heavy correctness-and-tuning week (~808 commits) shipped almost entirely from Trevor's box while the cloud pass stayed read-only under the persistent NO-PUSH. Two genuinely good numbers moved: **the accuracy gate rose to 34.9%** (on a stricter Top Shot denominator) and **WAU came off zero to 2**, with 104 saved wallets hinting at anonymous engagement the funnel isn't converting. Deep-audit run 4 (08-27) ran a full six-sweep pass and its main yield was a **pg_cron-waste cluster** (`#40`–`#43`) that reframes the structural saturation as a concrete query-tuning backlog rather than a capacity problem — `#42` alone is 22.6% of all cron time wasted, mostly to schedule alignment. The register nearly doubled its slots again (`#0–#30` → `#0–#54`), and the character of the new slots is the familiar one: **instruments that under-report** (the edge-fn drift detector's authoritative arm has never once produced a result — `#31`/`#53`; a pack-reality ranker draining to empty while both catching arms read greener — `#50`; param-blind SQL plans — `#52`). `#28` (sitemap truncation) closed. The board is GREEN with one structural trust breach (improving). Descending, concentrated risk: **(1) demand** — WAU 2 against a 50+ gate, still the whole ballgame; **(2) structural disk-IO saturation** — now itemized as `#40`–`#43` query waste; **(3) the standing operator items** — the credential purge (`#22`), Sentry dark (`#34`), the edge-fn-drift instrument (`#23`/`#25`/`#31`), the sports-proxy 403 (`#8`); **(4) the cloud NO-PUSH**, which keeps the autonomous pass read-only.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public since 07-17; self-serve since 07-20. Funnel wired. **Re-measured 2026-08-29: WAU 2 / 23 accounts / 104 saved wallets.** Accuracy gate 34.9%. The problem is *demand*. Gate: **50+ WAU** (§2.1) |
| **Accuracy gate climbing** | Estate-wide 30.1% → **34.9%**; Top Shot 39.9% on a now-stricter (all-rows) denominator; +275 HIGH/MED rows on an unchanged base (§2.3) |
| **Deep-audit run 4 + pg_cron waste (the week's substance)** | Run 4 (08-27) surfaced the cron-waste cluster: `#40` candy-listings truncation, `#41` market-index-daily 21.1% fail, `#42` 22.6% of cron time wasted, `#43` 48 inert `statement_timeout` declarations (§2.3 / §2.6) |
| Data-intelligence correctness / honesty | `#28` sitemap truncation CLOSED; `#37` React #418 fixed; new honesty finds `#50` (pack-reality ranker draining, both arms read greener), `#31`/`#53` (edge-fn drift authoritative arm never fires) — the house "failed read renders as a fact" class (§2.3) |
| **Structural saturation (decided, now itemized)** | Trevor's 08-23 no-capacity decision holds; run 4 converted it into a query backlog (#40–#43). Symptoms: fmv-recalc kill, board-MV timeouts (#27), chronic pipeline fail-rates (§2.6) |
| **Instrument darkness / operator-owned** | `#34` Sentry dark since 08-18 (org quota; Trevor: no spend); `#22` defeated credential purge; `#23`/`#25`/`#31` edge-fn-drift instrument red by design (§2.4 / §2.5) |
| Security | **0/0/0/0** invariants; the standing debt is **#22 (stale public branch, operator)** (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** (2026-08-01) — verified still absent (§2.9) |
| Chain expansion — BOTH boards PUBLIC | Candy `/insights/candy-mlb` (07-31); Panini `/insights/panini-squeeze` (08-01) — launch flags verified `true` (§2.8) |
| Cost / operational right-sizing | **DB 13,441 MB — DOWN ~407 MB** after reindex + vacuums. Disk-IO saturation STRUCTURAL — fix expensive queries / precompute, don't upgrade (§2.6) |
| Operational / overnight queue | **NO-PUSH (cloud)**; #47 candy-editions kills ~45%; #40–#43 cron waste; #27 board-MV timeouts; #54 match-topshot-players daily no-op; #8 sports-proxy 403 (§2.6) |
| Tech debt / refactor | Monoliths remain thin `page.tsx` + `*Client.tsx`: CollectionTabClient **1,393** / SniperClient **1,804** / CollectionAnalyticsClient **1,840** / DashboardClient **2,657** (measured this run) (§3) |
| Instrument hygiene | ledger rotated (1,394 live + H1/H2 archives); 338 un-archived inbox files pending a push-capable pass; **Sentry dark since 08-18** (#34) (§2.5) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled: no offer source exists — do not build the indexer) |

---

## 2. Critical path — start here

Go-live is **done**; **`docs/strategy/roadmap-2026-08-03.md`** is the canonical forward plan (stamped 2026-08-23, steers through 08-28). Its thesis: **accuracy is the GATE, not a phase** — "zero users is the correct output of the current input," so every growth tactic is removed rather than demoted until the data beats the sites collectors already use. Headline metric: **share of prices at HIGH/MEDIUM confidence** (34.9% estate-wide this week). The only user gate remains **50+ WAU**.

### 2.1 Launch + activation — the site is public; demand is the gap, now off zero — `Severity: High · Effort: Medium (built + measured, needs traffic)`

The un-gate shipped 07-17; self-serve magic-link signup opened 07-20. Read-only tabs are anonymous for the 5 published Flow collections; cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction re-read 2026-08-29 17:25 PT:** **23 total accounts (+2 in a week), WAU 2, 104 saved wallets**, newest signup 2026-08-25. **This is the first weekly report where WAU is not zero.** The **roadmap accuracy gate is 34.9% HIGH/MEDIUM** estate-wide (up from 30.1%). Per the roadmap, a low WAU is the *correct* state under a deliberately-unpromoted product — but the 104 saved wallets are worth noting: anonymous visitors are engaging enough to save wallets without converting to a sign-in.
- The reframe holds: the work is acquisition and accuracy, not instrumentation. The assets are built and idle: 30 `/insights` boards (both chain-two boards live), OG cards on every share surface, a working concierge with a real outcome-monitor, live alert loops.

Suggested next step: keep the accuracy gate climbing (dust-filter sale-floor decision, FMV confidence share), then pick **one** acquisition channel and run it against the 50+ WAU gate. Still the single most important item in the whole report.

### 2.2 Public intelligence surfaces — 30 public — `Severity: n/a (shipped) · context`

All 30 built surface dirs in `app/insights/` are public; the two chain-two boards read their data directly and carry their mandatory honesty disclosures (Candy's LOW-confidence FMV; Panini's listing-gated "floor, not a census" banner + `meta.coverage`). **Carried honesty risk surfaced this week:** `#50` — `/insights/pack-reality`'s "Honest +EV ranker" is draining toward empty while both arms meant to catch it read *greener* as it does (the same "failed read renders as a fact" class, applied to a ranker's emptiness test). **Open.** Some boards continue to serve last-good snapshots under saturation (surfaced honestly with an age stamp).

### 2.3 Data-intelligence — accuracy up, a deep-audit tuning week — `Severity: Medium (green; operator items) · Effort: mixed`

**FMV HIGH/MEDIUM confidence share:** the estate-wide roadmap gate reads **34.9%** (08-29). Per-collection: **Top Shot 39.9%** (7,868/19,742 — denominator now ALL rows per Trevor's 08-28 decision), **All Day 24.6%**, **Golazos 0.3%**, **UFC 0.0%**, **Candy 60.8%**. The Top Shot move (+278 HIGH/MED rows on an unchanged denominator) is attributable to the day's ask-cache refresh and the legacy-endpoint recovery (see below).

**Fixed / shipped since last week (mostly from Claude Code on Trevor's box):**

- **`#28` — `/sitemap/3.xml` truncation CLOSED.** Was open last week (served 24,000/27,246 editions under a 200 on a statement timeout). Code fix landed 08-23 (`9b862dc8`) and was **verified in production against the database 08-24**. The house honesty defect class, retired from the sitemap.
- **`#37` — a live React #418 hydration error in production RESOLVED 08-27**, verified deterministically (not by a lucky green run).
- **`#44` — three zero-yield UFC search pipelines RETIRED** (08-27, Trevor's call), taking a chronic smoke-test flap with them.
- **`#46` — a template-interpolation desync (the comment-stripper root, DEFECT 3) fixed and verified on the original file** (08-29).
- **`#53` — the edge-fn drift eszip census RAN** (08-30): 38/38 deployed bundles read; the fleet's real drift number is **25, not tier 1's 19**.
- **Top Shot legacy-endpoint outage RECOVERED.** A ~38h 530/1033 outage dominated 08-29/08-30 and self-recovered; FMV staleness back to 0.1h, and HIGH+MED Top Shot refilled 6,983→8,001 (100% attributable to the recovery).

**Surfaced by deep-audit run 4 (2026-08-27) — the pg_cron-waste cluster (all OPEN):**

- **`#42` — 22.6% of all pg_cron time is thrown away, 85.2% of it statement timeouts, driven by SCHEDULE ALIGNMENT** rather than any one slow job. The single highest-leverage saturation item.
- **`#43` — 48 active pg_cron jobs declare a `statement_timeout` that has NO EFFECT** (in both directions), and one has been failing on it. Matches the CLAUDE.md rule that a function-level `SET statement_timeout` is inert on pg_cron.
- **`#41` — jobid 235 `rpc-refresh-market-index-daily` fails 21.1%** of runs on a budget its own success distribution has outgrown.
- **`#40` — the candy listings sweep is FIXED but visibly TRUNCATED:** it spends its whole 240s budget on listings and sees `activities_seen: 0`.
- **`#52` — hot `LANGUAGE sql` RPCs plan PARAM-BLIND (generic plan) on PG 17.** The two headline reads are fixed; the class sweep is part-done. **Partial.**

**Regressed / measured-dead (carried):**

- **`#8` — the sports-proxy `403` remains MEASURED DEAD as a "proxy ESPN" fix.** Re-verified 08-27: `sync-nba-projections` **0 ok / 16 failed in 48h**, `all_upstreams_failed`; ESPN 403s residentially too, so a Cloudflare Worker is just another datacenter egress. The failure-rate alarm exists and is **deliberately suppressed to 2026-10-14** (sound: the predicate is "every upstream unreachable," not a code fault). Impact for projections deferred to preseason (~Oct). **Operator-only; the only cheap unrun experiment is a fetch from a *different* residential network.**

**Open / owed:**

- **FMV dust-filter *sale-floor* decision** (`docs/fmv-dust-filter-decision-2026-08-02.md`) — ANALYSIS ONLY, hand-off-only. FMV logic is Trevor's call; the highest-leverage accuracy-gate correctness change still queued.
- **One measured-but-unshipped DB fix, blocked on a DECISION not a diagnosis:** `compute_pack_ev_per_edition_weighted`'s `fmv_current` leg (**18,766 vs 1,046,192 buffers**, re-seeds a pinned fixture — Trevor's call).

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (green; 1 operator P0) · Effort: landed`

- **Security posture GREEN.** `metrics-latest.json`: **0/0/0/0** — invariants, anon-write holes, rls-off base tables, secdef-anon drift all clean (re-verified live 08-31).
- **🚨 `#22` — the 2026-08-03 credential purge remains DEFEATED (operator, needs Trevor).** `origin/claude/todo-implementation-e4tib3` branches from the ROOT commit, was never rewritten, and still carries the pre-purge blob on the **public** repo (re-verified through 08-27 by a third instrument). Bounded to one branch; the honest "ahead" figure is **one** draft commit (`ee94c8a2a`). Ordered operator fix: triage that commit → delete the branch **via the GitHub UI** (remote delete-ref 403s from the sandbox) → ask GitHub to GC → **rotate regardless**. Unchanged since last week.
- **`#25` — the Detector-Health sentinel arm stays inactive until `GITHUB_ACTIONS_READ_TOKEN` is set in Vercel env** (one env var, operator). It reads the last 12 runs of the watched workflows and keys on a failure streak.
- **`#23` / `#31` / `#53` — edge-function drift instrument (operator).** The drift detector's authoritative (tier-2 eszip) arm ran this week (`#53`): **25 of the deployed bundles genuinely drift from `main`**, not tier-1's 19. The pipeline sentinel arm is **LIVE CRITICAL by design** (12× red streak) because **6 of 25 drifted functions must NOT be redeployed** (their gate keys are unset) — so the red badge masks any *new* critical. The mechanism fix (read the `edge-fn-drift-report.json` artifact instead of the badge) is a GHA workflow change = code/push = queued.
- **DB-invariant SQL layer: 181 `supabase/tests/*.sql` files** (unchanged); live pin sweep not re-run this pass (last green 189/189 on 08-23). CI is **12 blocking jobs** (added `eslint-ratchet`, `register-guard`). **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

The cloud pass is queue-only when it cannot push (this run). **Hygiene state:** (1) `docs/overnight/ledger.md` was **rotated** — pre-08-10 entries rolled to `ledger-archive-2026-H2.md` by the biweekly `rpc-context-hygiene` job, so the live file holds **1,394** entries (the drop from last week's 1,916 is archival, not loss); (2) `docs/overnight/inbox/` holds **338 files** (append-only by design; INDEX asserts 337 live), un-archived pending a push-capable pass. ⚠ **`#34` — Sentry has been DARK since 2026-08-18** because the org error quota is exhausted; **Trevor decided against Sentry spend**, so mitigations were shipped instead. **A client-only failure is captured by nothing but the scheduled E2E DOM smoke badge** — "0 new issues" is instrument-silence, not proof of health.

### 2.6 Overnight operational queue — `Severity: Low–Medium · Effort: mixed`

Health is GREEN-with-known-noise. The one trust breach at capture is structural and improving. Open items:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **NO-PUSH git credential (cloud)** | The cloud clone carries no push credential → `git push` = "could not read Username" → **no overnight code deploys from the cloud pass, no inbox archival.** Trevor's box + Claude Code push fine. | **Med (operator)** | Restore cloud credential injection. |
| **pg_cron waste cluster (#40–#43)** | Run 4's headline: 22.6% of all cron time wasted (#42, schedule alignment), 48 inert `statement_timeout` decls (#43), market-index-daily 21.1% fail (#41), candy-listings truncation (#40). | Med (structural) | Fix expensive queries / re-stagger schedules; do NOT upgrade the tier. |
| **#47 candy-editions-ingest kills** | KILLED on ~45% of nights; the shipped fix is an EXPERIMENT with a stated falsifier still unread. | Med | Read `net._http_response` + the outcome table, not the scheduler self-report. |
| **#27 board-MV cron timeouts** | Three board MVs (deals/panini-squeeze/first-mint) carry a 600s `statement_timeout`; 15 of ~99 active jobs share that default. | Med (operator, one statement) | Re-run `cron.schedule` for the three at `'300s'`. |
| **#54 match-topshot-players daily no-op** | 20 of 30 daily runs "succeed" writing nothing; needs a PRODUCT DECISION (its input `nba_players` is starved by #8), not a fix. | Low (Trevor) | Root cause is the #8 sports-proxy 403. |
| **fmv-recalc — wasteful, not broken** | 64–73% wall-kills, ~14k editions/day. Re-characterized 08-17: it does its job; the kills are waste, not failure. | Low–Med | Lever is page size per invocation, not `maxDuration`. Saturation symptom. |
| **#8 sports-proxy 403** | ESPN/NBA/DK all 403; proxy-ESPN measured dead; alarm suppressed to 2026-10-14. | Med (operator, deferred) | Do NOT retire (sole writer for `nba_players`/projections). |
| **#34 Sentry dark** | Org error quota exhausted since 08-18; no client-error capture. | Med (operator) | Trevor: no Sentry spend — mitigations shipped. |

### 2.7 Pack EV / pack-viz — `Severity: Low (honest by construction) · Effort: landed`

Carried. Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. The one measured-but-unshipped DB fix here is `compute_pack_ev_per_edition_weighted`'s `fmv_current` leg (18,766 vs 1,046,192 buffers, Trevor's call — it re-seeds a pinned fixture). The `compute-*-pack-ev` edge functions are in the #23 drifted set (operator-gated redeploy).

### 2.8 Chain foundation — abstraction closed; BOTH expansions PUBLIC — `Severity: Low (shipped) · Effort: landed`

- **Chain-abstraction Phases A–F complete;** all re-export shims deleted 07-25. New code imports canonical `@/lib/chains/flow/...` only.
- **Candy / Solana — PUBLIC since 2026-07-31** (`CANDY_MLB_PUBLIC = true`, verified). Rollback = flag flip.
- **Panini — PUBLIC since 2026-08-01** (`PANINI_PUBLIC = true`, verified). Listing-gated coverage disclosure travels with the surface. Rollback = flag flip.
- **17 Cloudflare worker dirs** (verified); `atlas-proxy` (#20) remains **STILL WANTED but no longer the only path** — pg_net reaches Atlas today (48/48).

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** (2026-08-01) — verified this run: `lib/cart/`, `lib/trade-escrow/`, `app/dashboard/{trade-hub,gift}/` all **absent**. Inert Cadence templates kept as data; DB tables untouched. The product is purely read-only.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/resolved status of every numbered item.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** Public + self-serve ~6.5 weeks; **re-measured WAU 2 / 23 accounts / 104 saved wallets (2026-08-29)** — off zero for the first time. Accuracy gate 34.9%. The gap is demand, not measurement. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| 0 | **Wallet verification.** RESOLVED BY REMOVAL (2026-08-08): no wallet sign-in on any surface; the listing challenge is the only self-serve path. | Low | (resolved-by-removal) |

### Structural saturation / pg_cron waste (deep-audit run 4)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 42 | **22.6% of all pg_cron time thrown away, 85.2% statement timeouts, driven by schedule alignment.** Highest-leverage saturation item. | Med | Medium (re-stagger + tune) |
| 43 | **48 active pg_cron jobs declare a `statement_timeout` with NO EFFECT** (both directions); one fails on it. | Med | Medium |
| 41 | jobid 235 `rpc-refresh-market-index-daily` fails 21.1% on an outgrown budget. | Low–Med | Small |
| 40 | Candy listings sweep FIXED but visibly TRUNCATED (whole 240s on listings, `activities_seen: 0`). | Med | Medium |
| 52 | Hot `LANGUAGE sql` RPCs plan PARAM-BLIND on PG 17. Two headline reads fixed; class sweep part-done. | Med (partial) | Medium |

### Data-intelligence correctness / honesty

| Item | Issue | Severity | Effort |
|---|---|---|---|
| FMV confidence | Estate-wide accuracy gate 34.9% HIGH/MED (08-29). Golazos 0.3% / UFC 0.0% remain floors. | Medium | Ongoing |
| 50 | `/insights/pack-reality` "Honest +EV ranker" draining to empty; both catching arms read greener as it does. | Medium (open) | Small–Medium |
| 39 | Public `/insights/underpriced-serials` API 503s, mean 5,092 ms across 550 prod calls — a judgement fix (Trevor). | Medium (Trevor) | Medium |
| 33 | ISR bakes a failed read into the whole `revalidate` window; `/insights/pack-drops` has no stale fallback. | Medium (Trevor) | Small–Medium |
| FMV dust-filter | `$0.50` sale floor inflates ~46% TS / ~76% AllDay editions. **Decision doc queued — hand-off-only, Trevor's call.** | Medium | Small (decision) / medium (unwind) |

### Instruments / edge-function drift

| # | Issue | Severity | Effort |
|---|---|---|---|
| 31 | The edge-fn drift detector's AUTHORITATIVE arm has never once produced a result; every published number is tier-1's lower bound. | Med (operator) | Small–Medium |
| 53 | Eszip census RAN — real drift is **25**, not 19. (Resolved the census; the redeploy backlog is #23.) | (resolved census) | (landed) |
| 23 | 25 edge functions running code that is not `main`; the sentinel red-by-design (6 must NOT redeploy, gate keys unset). | Med (operator) | Medium |
| 25 | Detector-Health arm built + merged; **inactive until `GITHUB_ACTIONS_READ_TOKEN` set in Vercel env.** | Low (operator) | Trivial (one env var) |
| 34 | Sentry dark since 08-18 (org quota); Trevor: no spend. Client-only errors uncaptured. | Med (operator) | Trivial (billing) / medium (route work) |
| 32 | Installed `rpc-cron-ops` skill is a pre-06-19 export, missing a secret-safety rule. | Low (operator) | Trivial |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 | Monolith page refactor — Phase 1 complete; pages are thin `page.tsx` + `*Client.tsx`. Bulk lives in CollectionTabClient **1,393** / SniperClient **1,804** / CollectionAnalyticsClient **1,840** / DashboardClient **2,657** (measured this run). ⚠ register notes all three collection targets are mis-pointed the same way. Phase-2 splits remain. Plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (Phase-2 remains) |
| 10 | `/dashboard` token migration — logic in `DashboardClient.tsx` (**2,657** lines). | Low | Large |

### Page polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack/Moment/Set tune-up. Lower-value tier: modal a11y, Set B5/B7, the deferred `/ufc-strike/*`→`/ufc/*` 301. Audit docs are point-in-time. | Low–Medium | Medium (mostly done) |
| 11 | Brand punch list — ⚠ its named remaining item is a GHOST (since 2026-06-01). CI guard `scripts/check-brand-tokens.mjs` (present). | Low | Small |
| 12 | Blazers trivia — CLOSED 2026-08-17: cited file `lib/blazers-trivia.ts` verified ABSENT this run. Do not re-open without confirming the file exists. | Low (closed) | Trivial |

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
- **Supabase compute is `SMALL` (2 GB / 2-core)** — saturation is disk-IO-budget-bound and STRUCTURAL; run 4 itemized the waste as `#40`–`#43`.
- **A function-level `SET statement_timeout` is INERT on pg_cron** — proven again this week (`#43`: 48 inert declarations).
- **The eighth caller source is real:** a Windows Scheduled Task on Trevor's box runs four production ingests — invisible to all six repo sources plus cron-job.org. Enumerate it before calling any ingest dead.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old two-item list is replaced by **`docs/strategy/roadmap-2026-08-03.md`** (verified present, stamped 2026-08-23), canonical:

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM confidence share must beat the sites collectors already use before growth tactics return.** | **Advancing — estate-wide gate 30.1% → 34.9%; TS 39.9% on a now-stricter denominator.** Dust-filter sale-floor decision still queued. |
| 1 | **Prove the product with real users — the only user gate is 50+ WAU.** | **Open — the critical path.** Instrumentation done; **WAU off zero to 2 (2026-08-29)** (§2.1). |
| 2 | Cost / latency levers. | Advancing but bounded — saturation is STRUCTURAL; run 4 gave it a concrete backlog (#40–#43). DB −407 MB after a reindex. |
| 3 | Durable debt. | **Heavy advance** — run 4 drain; #28 closed; #37/#44/#46/#53 closed; eslint + register CI guards added. |
| 4 | Chain two, readiness-gated. | **DONE — both boards PUBLIC** (Candy 07-31, Panini 08-01). |

**Standing guardrails:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (now eight sources, including Trevor's box Task Scheduler).

**Housekeeping still outstanding:** action the credential-purge cleanup (#22); set `GITHUB_ACTIONS_READ_TOKEN` (#25); re-run `cron.schedule` for the three board MVs at `'300s'` (#27); redeploy the drifted edge functions with both flags (#23, off-limits classes excluded).

---

## 5. In-code TODO inventory

A first-hand `ripgrep` scan over `app/ lib/ components/ workers/ supabase/functions/ scripts/ docs/drafts/ proxy.ts` (node_modules/.next/.git excluded) found **no actionable markers in live application code** — unchanged in character from prior weeks. Breakdown:

### 5a. Candy launch-flag-gated "note" branches (2 markers) — keep by design

- `app/api/candy-sales-indexer/route.ts:185` and `app/api/ingest/candy-editions/route.ts:182` — `note: "…still a TODO_-prefixed placeholder"` strings inside launch-flag-gated defensive branches. Constants are filled; branches unreachable in practice. Not actionable.

### 5b. Solana readiness-guard refs (6 markers) — guard functions, not open work

- `lib/chains/solana/normalize.ts` — the `startsWith("TODO_")` readiness-guard functions (lines 360/364) + their `TODO_3/4/5 RESOLVED` narrative (lines 46/54/59/150/355). Placeholder-guards, not open TODOs.

### 5c. Panini draft/reference lines — draft-only, all closed

- `docs/drafts/panini/ingest-panini-runner.mjs` (`TODO(go-live) RESOLVED 2026-07-16/19`, plus one enumeration back-reference) and `docs/drafts/panini/panini-proxy/index.js:19` (`TODO(discovery) CLOSED 2026-07-19`) — annotated resolved/closed draft scaffolding.

### 5d. Narrative / false positives (rest)

- **~4 narrative/false-positive lines:** `lib/rtr-lock-roi-weights.ts:7` + `app/api/rtr/lock-roi/route.ts:38` ("resolves the standing … TODO" / "v2 folds in the two signals the v1 TODO called out"), `lib/format.ts:6` (a `"$X,XXX.XX"` format doc), and a migration comment (`supabase/migrations/20260713050000_…:4` "was a TODO in `components/collection/CollectionMomentTable.tsx`"). All describe *resolved* work.
- ⚠ **Method note:** a whole-repo `grep -r` over the large SQL corpus times out (documented in prior reports; it timed out again this run). `ripgrep` with negated globs scoped to source dirs returned promptly and is the basis here. The `workers/**/node_modules/` tree contains vendored TODO markers — excluded as third-party, not RPC code.

> **Net change since last week:** none of consequence. Live application code has zero actionable TODO markers.

---

## 6. Resolved / no action needed

Verified against the codebase, `docs/reference/known-issues.md`, `docs/audits/deep-audit-register.md`, and `docs/overnight/metrics-latest.json`:

**Known-issue slate (carried, still resolved):** #0 (wallet verification, resolved-by-removal), #1 (Cart, deleted), #3 (Trade Hub, deleted), #3b (Gifting, deleted), #4 (Pinnacle FMV + ASK_ONLY drop), #5, #7, #9, #12 (closed — file absent), #13, #15, #16, #19 (pg_cron ownership block), #24 (6 DB pins). ⚠ **#2 Sentry SDK is wired but the org is DARK since 08-18 (#34).** ⚠ **#8 remains REGRESSED / measured-dead** — see §2.3/§9.

**Newly resolved / closed since last week:**
- **#28 sitemap truncation** — code fix 08-23 (`9b862dc8`), verified in production against the DB 08-24. The last open instance of the sitemap honesty defect.
- **#37 React #418** — a live production hydration error, RESOLVED 08-27, verified deterministically.
- **#44** — three zero-yield UFC search pipelines RETIRED (08-27), chronic smoke-test flap gone.
- **#45** — an unbounded eslint ratchet driven 21 → 11 → 1 across 08-27/28 (the residual 1 is a checked exclusion).
- **#46** — the comment-stripper template-interpolation desync (DEFECT 3) fixed + verified 08-29.
- **#53** — the edge-fn drift eszip census RAN (08-30): 38/38 bundles read, real drift = 25.
- **CI 10 → 12 blocking jobs** (`eslint-ratchet`, `register-guard`).

---

## 7. Suggested sequence

A pragmatic order under the **accuracy-is-the-gate** framing (`docs/strategy/roadmap-2026-08-03.md`):

1. **Action the standing operator items — Trevor.** (a) **Clean up the defeated credential purge (#22)** — triage `ee94c8a2a`, delete `claude/todo-implementation-e4tib3` via the GitHub UI, ask GitHub to GC, rotate regardless. (b) **Decide Sentry (#34)** — a client-error blind spot has stood since 08-18; either fund the quota or accept the E2E DOM smoke badge as the sole detector. (c) **Set `GITHUB_ACTIONS_READ_TOKEN`** to activate the detector-health arm (#25). (d) **Re-run `cron.schedule` for the three board MVs at `'300s'`** (#27).
2. **Restore the cloud git push credential (§2.6) — operator.** Blocks the autonomous pass's code shipping + inbox archival. Trevor's box + Claude Code are unaffected.
3. **Drive traffic against the 50+ WAU gate (§2.1).** WAU off zero to 2; 104 saved wallets suggest anonymous engagement the funnel isn't converting. Keep the accuracy gate climbing, pick one channel. Still unambiguously the top product item.
4. **Attack the pg_cron-waste cluster (#42 → #43 → #41 → #40).** Run 4's highest-leverage saturation finding: 22.6% of cron time wasted, mostly to schedule alignment — a re-stagger, not a capacity buy. The most leverage available against the *decided* structural saturation.
5. **Fix #50 (pack-reality ranker draining) and #33 (ISR bakes a failed read).** Both are live instances of the house "failed read renders as a fact" class on public surfaces.
6. **Redeploy the drifted edge functions (#23) with both flags** — operator, off-limits classes excluded (the 6 whose gate keys are unset stay put); confirm the next census goes green, and switch the sentinel to read the artifact not the badge (#31).
7. **Put the FMV dust-filter *sale-floor* decision in front of Trevor (§2.3).** Highest-leverage accuracy-gate correctness change still queued; hand-off-only.
8. **Deep-audit tails as capacity allows** — #47 (candy-editions kills), #54 (match-topshot-players no-op, a product decision downstream of #8), #52 (param-blind plan sweep). Archive the 338 inbox files once a push-capable pass runs.

---

## 8. Notes from verification

- **Shell GREEN this run.** Commit counts, line counts, path checks, and the TODO scan are all first-hand (`git log`, `ripgrep`, `wc -l`, `ls`). ⚠ **git PUSH is dead** in the cloud sandbox (`git push --dry-run origin main` → "could not read Username") — Trevor's box + Claude Code push fine and did essentially all of this week's shipping.
- **Commits measured:** `git log --since=2026-08-24` = **~808** (132/87/103/75/117/169/123/2 across Aug 24–31). HEAD `7ee060d4` (2026-08-31 03:02 PT, an edge-fn-drift report fix).
- **TODO scan: 0 actionable markers in live app code** (§5) — measured via `ripgrep` over the source tree; `workers/**/node_modules` vendored markers excluded; whole-repo `grep -r` over the SQL corpus timed out (documented).
- **Deletions verified by absence:** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift` — all absent. **`lib/blazers-trivia.ts` verified ABSENT** (slot #12 correctly CLOSED). `docs/FREEZE.md` absent → no active freeze.
- **Launch flags verified in `lib/launch-flags.ts`:** `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`.
- **Counts measured this run:** CI = **12** jobs (`.github/workflows/ci.yml`, added `eslint-ratchet` + `register-guard`); DB test files = **181** (`supabase/tests/*.sql`; live pin sweep not re-run — last green 189/189 on 08-23); Vercel crons = **35** (`vercel.json`); worker dirs = **17**; edge functions = **40** (`supabase/functions/`); `app/insights/*` dirs = **30**; `app/**/page.tsx` = **120**; `app/api/**/route.ts` = **454**; `lib/**/*.ts` = **317**; `components/**/*.tsx` = **153**; monolith client files 1,393 / 1,804 / 1,840 / 2,657.
- **Cited paths spot-checked — all resolve:** `docs/strategy/roadmap-2026-08-03.md`, `docs/reference/known-issues.md`, `docs/reference/schema-truth.md`, `docs/reference/roadmap-status.md`, `docs/reference/autonomous-tasks.md`, `docs/audits/deep-audit-register.md`, `docs/audits/deep-audit-2026-08-27.md`, `docs/fmv-dust-filter-decision-2026-08-02.md`, `docs/audits/refactor-plan-monolith-pages-2026-05.md`, `scripts/check-brand-tokens.mjs`, `scripts/lib/strip-comments.mjs`, `lib/launch-flags.ts`, `supabase/migrations/20260823070000_audit_20260823_retire_dead_fcl_wallet_auth_objects.sql`. **Absent (correctly):** `lib/blazers-trivia.ts`, `lib/cart`, `lib/trade-escrow`, `app/dashboard/{trade-hub,gift}`, `docs/FREEZE.md`.
- **Ledger rotation confirmed:** `docs/overnight/ledger.md` holds **1,394** `### ` entries (down from 1,916) because the biweekly `rpc-context-hygiene` job rolled pre-08-10 entries to `ledger-archive-2026-H2.md` (2.6 MB) — archival, not loss. `docs/overnight/inbox/` holds **338 files**; `INDEX.md` asserts **337 live**.
- **DB-side facts** (DB size **13,441 MB**, editions **27,331**, security 0/0/0/0, 1 trust breach, pipeline fail-rates) come from **`docs/overnight/metrics-latest.json` (2026-08-31T08:10Z — same day, real-time from DB)**. **Traction + accuracy** come from **`docs/reference/roadmap-status.md` re-read 2026-08-29 17:25 PT**: **23 accounts / WAU 2 / 104 saved wallets**, estate-wide accuracy **34.9%**. The nightly metrics run did **not** re-capture traction, so the freshest available reading is 2 days old. **Sentry dark since 08-18** — "0 new" is instrument-silence.
- **Deep-audit register reconciliation:** run 4 (2026-08-27) is the latest pass; the register was rewritten in the same commit and now carries 52 numbered items (29 open · 5 partial · 18 closed per its own STATUS INDEX).
- **Autonomous-task caveat:** the daytime monitor + night pass run against this repo, and Claude Code pushed heavily from Trevor's box this week (~808 commits), so the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` + `docs/audits/deep-audit-register.md` are the authoritative records.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-08-31)

The register's own generated STATUS INDEX (line 37 of `docs/reference/known-issues.md`) reports **52 numbered items — 29 open · 5 partial · 18 closed**, derived from each item's own first sentence. Spot-checked against the repo below; "Verified status" is what the code/docs show. ⛔ `closed` means the item *says* it is closed — read its own date stamp.

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | ✅ closed | Resolved-by-removal (08-08) | `resolve_wallet_challenge_match` present |
| 1 / 3 / 3b | Cart / Trade Hub / Gifting | ✅ closed | Removed from the tree (08-01) | dirs absent |
| 4 | Pinnacle FMV | ✅ closed | Resolved (ASK_ONLY drop fixed 08-16) | `pinnacle_fmv_recalc_render_all.sql` pin |
| 8 | NBA stats / sports-proxy 403 | 🟡 open | **REGRESSED / measured-dead** — 0 ok, `all_upstreams_failed`; alarm suppressed to 2026-10-14 | known-issues #8 |
| 10 | `/dashboard` token migration | 🟡 open | Open — logic in `DashboardClient.tsx` (2,657 lines) | this run |
| 11 | Brand punch list | 🟡 open | Open — named remaining item is a ghost | `check-brand-tokens.mjs` present |
| 12 | Blazers trivia | ✅ closed | Closed — file ABSENT | `find **/blazers*` → none |
| 14 | Monolith page refactor | 🟡 open | Open — Phase 2 remains; bulk in Client files (1.4k–2.7k lines) | measured this run |
| 17 | Pack/Moment/Set tune-up | 🟡 open | Open — lower-value tier | register |
| 18 | Deep audit run-2 findings | 🟡 open | Superseded by runs 3 + 4 | register |
| 19 | pg_cron ownership block | ✅ closed | Resolved (08-22) | known-issues #19 |
| 20 | atlas-proxy | 🟡 open | Open — wanted but pg_net reaches Atlas today (48/48) | known-issues #20 |
| 21 | topshot-moments-hydrator cron undeclared | 🟡 open | Open — a `wrangler deploy` would DELETE its cron | known-issues #21 |
| 22 | 🚨 Credential purge DEFEATED (public branch) | 🟡 open | **Open — SECURITY** — pre-purge blob still fetchable (3rd instrument, 08-27) | known-issues #22 |
| 23 | edge fns running non-`main` build | 🟡 open | Open — real drift = 25 (per #53 census); 6 must NOT redeploy | known-issues #23/#53 |
| 24 | 6 live-drifted DB pins | ✅ closed | Resolved (08-22/23) — live green 189/189 | known-issues #24 |
| 25 | Nothing reads GHA instruments | 🟡 open | Open — arm inactive until `GITHUB_ACTIONS_READ_TOKEN` set | known-issues #25 |
| 26 / 26b | `/api/ready` 500 / privilege leak | 🟠 partial / ✅ closed | Leak REVOKED; route flaps with saturation band | known-issues #26 |
| 27 | 3 board-MV crons carry 600s timeout | 🟡 open | Open — one `cron.schedule` per job at `'300s'` | known-issues #27 |
| 28 | `/sitemap/3.xml` truncation | ✅ closed | **Resolved — code fix 08-23, verified in prod 08-24** | known-issues #28 |
| 29 | `allday-pack-opens-backfill` rate | 🟡 open | Open (downgraded) — failures upstream + pool | known-issues #29 |
| 30 | `topshot-active-listings-ingest` DB-timeout | 🟡 open | Open — index shipped; residual is egress_blocked (35.3%) | known-issues #30 |
| 31 | Edge-fn drift authoritative arm never fires | 🟡 open | Open — every published number is tier-1's lower bound | known-issues #31 |
| 32 | Installed `rpc-cron-ops` skill stale | 🟡 open | Open (operator) — missing a secret-safety rule | known-issues #32 |
| 33 | ISR bakes a failed read | 🟡 open | Open (Trevor) — `/insights/pack-drops` no stale fallback | known-issues #33 |
| 34 | Sentry org quota exhausted | 🟡 open | **Open (operator)** — dark since 08-18; Trevor: no spend | known-issues #34 |
| 35 | Two pack-sales backfills 71.9 GB/day for ~165 rows | 🟠 partial | Partial | known-issues #35 |
| 36 | `refresh_wmc_fmv_changed` = 40.2% of dirtied blocks | 🟡 open | Open, push-gated | known-issues #36 |
| 37 | React #418 in production | ✅ closed | Resolved 08-27, verified deterministically | known-issues #37 |
| 38 | `topshot-pack-pool-backfill` ~99.6% fail | 🟡 open | Open, promoted from inbox 08-26 | known-issues #38 |
| 39 | `/insights/underpriced-serials` 503s | 🟡 open | Open (Trevor) — mean 5,092 ms / 550 calls | known-issues #39 |
| 40–43 | pg_cron-waste cluster | 🟡🔴 open | Open — 22.6% cron time wasted (#42); 48 inert timeouts (#43) | known-issues #40–#43 |
| 44 | 3 zero-yield UFC pipelines | ✅ closed | Retired 08-27 (Trevor) | known-issues #44 |
| 45 | eslint ratchet unbounded | ✅ closed | Resolved 08-28 (driven to 1) | known-issues #45 |
| 46 | comment-stripper desync (DEFECT 3) | ✅ closed | Resolved 08-29, verified | known-issues #46 |
| 47 | `candy-editions-ingest` ~45% killed | 🟡 open | Open — fix is an experiment with unread falsifier | known-issues #47 |
| 48 | experiment falsifier unanswerable | 🟡 open | Open — proposed fallback lever does not exist | known-issues #48 |
| 49 | `/api/analytics/sales/leaderboard` | 🟠 partial | Partial — fixed on the shape users hit; one leg costly | known-issues #49 |
| 50 | pack-reality "Honest +EV ranker" draining | 🟡 open | Open — both catching arms read greener | known-issues #50 |
| 51 | arm asserting an unobservable cause | 🟠 partial | Partial — arm no longer asserts the cause | known-issues #51 |
| 52 | param-blind SQL plans on PG 17 | 🟠 partial | Partial — two headline reads fixed; class sweep part-done | known-issues #52 |
| 53 | edge-fn eszip census | ✅ closed | Resolved 08-30 — 38/38 bundles read, real drift 25 | known-issues #53 |
| 54 | `match-topshot-players` daily no-op | 🟡 open | Open — needs a product decision (downstream of #8) | known-issues #54 |

**Tally (per the register's own STATUS INDEX):** **52 numbered items — 29 open · 5 partial · 18 closed.** Plus the live **deep-audit register** (run 4, 2026-08-27), the **34.9% accuracy gate**, **Candy + Panini public boards**, **12-job CI**, **181 DB-invariant test files**, and the **30 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** two numbers that had been stuck moved this week — **the accuracy gate rose to 34.9%** (on a stricter, all-rows Top Shot denominator) and **WAU came off zero to 2**, with 104 saved wallets pointing at anonymous engagement the funnel isn't converting. The register grew again (`#0–#30` → `#0–#54`) and the new slots are the familiar house classes: a deep-audit-4 **pg_cron-waste cluster** (`#40`–`#43`) that turns the *decided* structural saturation into a concrete re-stagger-and-tune backlog rather than a capacity buy, and another wave of **instruments that under-report** (`#31`/`#53` the edge-fn drift arm; `#50` a ranker draining while its watchers read greener; `#52` param-blind plans). `#28` closed the last sitemap honesty defect. The standing operator queue is unchanged and still needs a human: **the defeated credential purge (`#22`)**, **Sentry dark since 08-18 (`#34`)**, the **edge-fn-drift instrument (`#23`/`#25`/`#31`)**, and the **sports-proxy 403 (`#8`)** deferred to preseason. And the top-line framing is the same, now with a flicker of movement: with the site public and self-serve ~6.5 weeks, **WAU is 2 against a 50+ gate** — **demand is still the one number that decides everything**, but it is no longer flat zero.
