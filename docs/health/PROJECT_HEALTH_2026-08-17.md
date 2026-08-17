# Rip Packs City — Project Health Report

**Date:** 2026-08-17
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Testing & CI §, Recent Sessions § — current through the 2026-08-16/17 entries), `docs/audits/deep-audit-register.md` (run 2, **2026-08-15**) + `docs/audits/deep-audit-2026-08-15.md`, `docs/overnight/metrics-latest.json` (captured **2026-08-17T08:10:00Z**, same day), `docs/overnight/focus.md` (**stale, dated 2026-06-24**), `docs/overnight/ledger.md` (**1,618** `### ` entries), plus a first-hand `git log` + `ripgrep` scan and file-existence verification (the workspace shell is **GREEN** this run).
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#18`), the deep-audit register (`D…`/`R…` findings), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-08-10.md` (7 days ago). This regeneration mirrors its structure. `_2026-08-03.md` … `_2026-05-22.md` (fifteen prior reports) also live in `docs/health/`.

> **✅ Tooling note — the shell is BACK. Real `git`/`rg` this run.** The 9-night `/sessions` "no space left on device" outage that killed the workspace VM for the last three reports is **CLOSED** (verified: public clone succeeded, `git log`/`ripgrep`/`wc -l` all run). So this report carries **measured** commit counts, line counts, and a first-hand TODO scan again. ⚠ **BUT a different NO-PUSH cause has replaced it:** the mounted clone's `remote.origin.pushurl` **has no embedded credential** (`git push --dry-run` = "could not read Username"), so autonomous **code deploys are still blocked** — DB migrations and artifact repairs would apply, but nothing that needs a git push can ship. The 08-17 overnight pass shipped **0 / reverted 0 / repaired 0** for this reason, and ~35 consumed inbox files (Aug 9–14) remain un-archived pending push restoration.

> **⚠ Date nuance.** The harness stamps today as **2026-08-17** (UTC); the freshest metrics were captured **08:10Z = 01:10 PT Aug 17**. Ledger/session dates in `CLAUDE.md` are Pacific. Filed under **2026-08-17** per the weekly-regeneration convention (prior report 08-10, exactly 7 days back).

> **Report location stays clean.** All sixteen reports (this one included) live in `docs/health/`; the repo root holds none.

> This is a snapshot. `CLAUDE.md` is the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/audits/deep-audit-register.md` for the deep-audit findings. This doc reorganizes all three for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-08-10 — the single heaviest engineering week on record, dominated by a test/correctness campaign and one genuinely large data-integrity find.** Five stories. **(1) The `*Client.tsx` conversion + honesty-ratchet workstream FINISHED.** The client-page conversion ratchet is drained to its floor (`BUDGET = 1`, the lone remaining page is a hard 404), and the "a failed read must not render as an answer" class was swept exhaustively across pages, components, OG cards, the concierge, and alerts — well over a dozen new instances fixed, several of them false claims about the reader's *own* account. **(2) A fabricated-data bug on the scale of six figures.** A new NBA-buyback analytics board was found to be publishing **161,797** "buyback acquisitions" that never happened — root cause a `.range()` pagination loop with no `ORDER BY` in `snapshot-institutional-wallets`, silently corrupting a snapshot for ~3 months. The true figure is ~6. Fixed; `paginated-range-requires-order` is now a **ban at zero**. **(3) The FMV/pipeline machinery kept ratcheting hard:** DB-invariant pins **122 → 180**, the primary coverage gate to **91.3/78.6/93.1/93.4**, the component gate to **90.3/81.6/89.1/93.2**, a **9th CI job** (`worker-tests`, its own 85.1/72.1/83.8/88.1 gate), and the trust-precompute refresh split into **8 per-leg pg_cron jobs** (pg_cron **85 → 93**). **(4) A regression re-opened #8:** `sync-nba-projections` has failed 100% of its runs for 13 days on a sports-proxy **403** — and it is the single root cause of three symptoms triaged separately (projections 27d stale, the NBA player catalogue 101d stale, and `match-topshot-players` failing 100% since 08-14, with Fast Break now running on a 19-team roster). **(5) The concierge was down ~2 weeks with the smoke test reporting ALL PASSED** — found and fixed (outcome-based check keyed on category, not an opt-in paid probe).

> **Overnight reality — GREEN-with-known-saturation-noise; NO-PUSH (new cause).** The 08-17 genuine-overnight pass (01:10 PT) shipped **0** — shell GREEN but the *cloud sandbox's* git push credential missing (⚠ scoped to that sandbox: push from Trevor's local box was verified working 08-17). Post-ship watch over the very large 08-15/16 wave was **PASS, 0 reverts** (apply-fmv-haircut per-collection split confirmed; drain-fmv-cold-tail telemetry fix confirmed; the 8-way leg split holding; the fmv-recalc wedge recovered to 0.39h). Health at capture: security **0/0/0/0**; **0** new/regressed Sentry in 48h (the 6 open issues are all "smoke check could not run" honest-degradation under saturation); **3 trust breaches — all pre-known/carried**: `panini_sale_price_capture_dry_days=20` (upstream residential-box capture outage since ~07-29, +1/day — operator), `unmapped_resolution_backlog_max=291` (AllDay permanent floor), and `public_board_slow_count=5` (saturation collateral, oscillating DOWN from 12). Two arms that were red last week — `fmv_sweep_wedge_hours` and `trust_precompute_max_age_hours` — **cleared** at capture.

> **Traction reality — still the headline concern, and NOT re-captured this run.** `metrics-latest.json` was a DB-read/queue pass and did **not** capture a user/WAU count. The last confirmed reading (2026-07-26) was **20 users / 0 new signups / 0 WAU**, and nothing this week indicates movement. The site has been public since 07-17 and self-serve since 07-20; the machinery is built, instrumented, and idle. **Demand — not features, not correctness, not measurement — is the one number that decides everything, and it is unconfirmed-but-presumed-flat.**

> **Cost / storage — UP again.** DB is **13,114 MB, +742 MB** over last week's 12,372. **Disk-IO budget on the SMALL (2 GB / 2-core) Supabase instance remains the binding operational constraint** — it is the direct cause of the `public_board_slow_count` breach, the fmv-recalc kill rate (~50%+ of invocations), the `get_collection_stats` timeout, and the statement-timeout pg_cron alerts. The documented lever is **fixing expensive queries and precomputing, NOT upgrading the tier** (Medium is the same 2 cores for 4× the cost).

> **Platform context (unchanged).** **(1) Flowty** frontend shut but API ALIVE and feeding live ingest. **(2) NFL All Day** primary pack sales ended; secondary-market only. **(3) UFC Strike** Flow market frozen (0 sales; honestly labelled; the revival arm is `ufc_flow_revival_sales_30d`). **(4) Candy / Solana** — PUBLIC since 07-31. **(5) Panini** — PUBLIC since 08-01 (listing-gated coverage disclosed structurally). **(6) Expansions are readiness-gated, not sequence-gated.**

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md` — **1,618** entries, `inbox/`, `metrics-latest.json`, `focus.md` — **~54 days stale**, `.lock`). `docs/FREEZE.md` (absent this run → no freeze) halts all autonomous shipping. **Check `docs/overnight/ledger.md` and `docs/audits/deep-audit-register.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#18** | **NEW slot #18** this week (the 2026-08-15 deep-audit run 2). `#3` still double-labelled. See §9. |
| Known issues — resolved | 11 | #2, #3 (Flowty), #4, #5, #6, #7, #13, #15, #16 + the fmv-recalc silent stall + #12 (file removed). — §6 / §9 |
| Known issues — open / partial | **6** | #0 (mostly resolved-by-removal), #10, #11, #14, #17, **#18 (new)** — §3 / §9 |
| Known issues — **REGRESSED / re-opened** | **1** | **#8 NBA stats** — re-opened 2026-08-16: `sync-nba-projections` 100% fail 13 days on a sports-proxy 403; root cause of 3 downstream symptoms. — §2.3 / §9 |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot, 2026-08-01). Verified still absent. |
| Known issues — retired | 1 | #9 Storefront audit pipeline |
| **Deep-audit register (run 2, 2026-08-15)** | **~14 open / several resolved-since** | 1 **P0** still owed (D2b, operator secrets), R1/R2/R3 (2×P0 + P1) shipped `8f59749b`, R7 resolved-in-prod 08-16, D25 drained, R4/R8/R9 re-pointed as wrong-as-filed. — §2.3 / §3 |
| Commits this week | **~843** | Measured (`git log --since 2026-08-10`): 76 (11th) · 38 (12th) · 135 (13th) · 41 (14th) · **202 (15th)** · **273 (16th)**. The heaviest week on record. |
| Net-new shipped / landed this week (not numbered) | **many** | Client-page conversion + honesty-ratchet workstream **FINISHED**; **161k-fabricated-row buyback bug fixed** (`paginated-range` ban); concierge 2-week outage fixed; 8 anon-exec invoker fns revoked; Pinnacle FMV ASK_ONLY drop fixed (#4); **8-way trust-precompute split**; avatar system; DB pins 122→180; ratchets raised; **9th CI job**. — §2 / §6 |
| Open overnight operational items | **~7 active + standing queue** | NO-PUSH (git credential, operator); candy-editions-ingest timeout-kill (2 missed ticks); fmv-recalc ~50% kill rate; disk-IO MV cluster; panini price-capture dry 20d (operator); sync-nba-projections 403 (operator); AllDay unmapped inflow — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana (PUBLIC) + Panini (PUBLIC); multi-chain abstraction Phases A–F complete — §2.8 |
| Prioritized next actions | **superseded** | `docs/strategy/roadmap-2026-08-03.md` is canonical (accuracy-is-the-gate). Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **0 actionable in live app code** (+2 launch-flag-gated candy "note" branches by design, +7 solana readiness-guard refs, +4 panini draft-doc lines all `RESOLVED`/`CLOSED`, +1 migration-comment, +a few false positives/test refs) | Measured via `ripgrep` — §5 |
| Test / DB-invariant pins | **180 pins over 179 fns** (172 `supabase/tests/*.sql` files incl. `_helpers.sql`) | Was 122. Primary ratchet 91.3/78.6/93.1/93.4; component 90.3/81.6/89.1/93.2; **worker gate NEW** 85.1/72.1/83.8/88.1. |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** The single heaviest engineering week on record — and its character is *correctness hardening*, not features. The `*Client.tsx` conversion + honesty-ratchet campaign is **done**, and swept out a long tail of "a failed read renders as a confident answer" defects (several of them false claims about the reader's own account). The week's most important single find was a **six-figure fabricated-data bug** (a buyback board publishing 161,797 acquisitions that never happened, from one missing `ORDER BY` in a pagination loop) — a stark reminder that a correct row *count* is not a correct row *set*. The test machine ratcheted hard (pins 122→180, higher gates, a 9th CI job, the 8-way trust-precompute split). Two things regressed or newly bit: **#8 NBA projections** (100% fail 13 days on a sports-proxy 403 — one operator secret, three downstream symptoms) and the **concierge** (down ~2 weeks with a smoke test reporting green). The board is GREEN-with-known-saturation-noise (3 trust breaches, all carried). Descending, concentrated risk: **(1) demand** — the only gate (50+ WAU), last-measured 0, un-remeasured; **(2) the NO-PUSH git-credential failure** — blocks all autonomous code shipping; **(3) the standing operator secrets** — the P0 gate-key rotation (D2b) and the sports-proxy 403 (#8); **(4) disk-IO saturation** on the SMALL instance (DB +742 MB), which drives the fmv-recalc kill rate, the deals-board staleness, and the `get_collection_stats` timeout.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public since 07-17; self-serve since 07-20. Funnel wired. Last-measured **20 users / 0 WAU**; **not re-measured this run**. The problem is *demand*. Gate: **50+ WAU** (§2.1) |
| **Test / correctness campaign (the week's substance)** | Client-page conversion FINISHED; failed-read-renders-as-answer class swept across pages/components/OG/concierge/alerts; **161k fabricated-row bug fixed**; pins 122→180; 9 CI jobs; 8-way trust split (§2.3 / §2.4) |
| Data-intelligence correctness / honesty | FMV HIGH/MED share re-measured (TS 52.8% / AllDay 24.5% / Candy 60% / Pinnacle 40.7% / Golazos 0.9% / UFC 0.0%). Pinnacle FMV ASK_ONLY drop **fixed** (#4). FMV dust-filter *sale-floor* decision still **QUEUED, hand-off-only** (§2.3) |
| **Regressions / operator-owned** | **#8 sports-proxy 403** (projections/player-catalogue/matcher/Fast Break — 1 secret); concierge 2-week outage (fixed); Panini price-capture dry 20d (operator) (§2.3 / §2.6) |
| Security | **0/0/0/0** invariants; 8 anon-executable INVOKER fns revoked (84→78); a new guard freezes the anon-exec population; the standing debt is **D2b (P0 gate-key rotation, operator)** (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** (2026-08-01) — verified still absent (§2.9) |
| Chain expansion — BOTH boards PUBLIC | Candy `/insights/candy-mlb` (07-31); Panini `/insights/panini-squeeze` (08-01) — launch flags verified `true` (§2.8) |
| Cost / operational right-sizing | **DB 13,114 MB — UP ~742 MB.** **Disk-IO budget on the SMALL instance is the binding constraint** — fix expensive queries, don't upgrade the tier (§2.6) |
| Operational / overnight queue | **NO-PUSH (git credential, operator)**; candy-editions-ingest timeout-kill; fmv-recalc ~50% kill rate; disk-IO MV cluster; panini dry 20d; sync-nba-projections 403 (§2.6) |
| Tech debt / refactor | Monoliths were **SPLIT** into thin `page.tsx` + `*Client.tsx` (for testability): CollectionTabClient 1,331 / SniperClient 1,804 / CollectionAnalyticsClient 1,798 / DashboardClient 2,613 (§3) |
| Stalled / scaffolded features | Cart / Trade Hub / Gifting DELETED. Breaks (dormant). Blazers trivia file still absent though `CLAUDE.md` #12 re-cites it (§3) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; `badge_editions.low_ask` (AllDay+Golazos resolved; `highest_offer` residual gap) |

---

## 2. Critical path — start here

Go-live is **done**; **`docs/strategy/roadmap-2026-08-03.md`** is the canonical forward plan (supersedes 07-18). Its thesis: **accuracy is the GATE, not a phase** — "zero users is the correct output of the current input," so every growth tactic is removed rather than demoted until the data beats the sites collectors already use. Headline metric: **share of prices at HIGH/MEDIUM confidence.** The only user gate remains **50+ WAU**.

### 2.1 Launch + activation — the site is public; demand is the gap — `Severity: High · Effort: Medium (built + measured, needs traffic)`

The un-gate shipped 07-17; self-serve magic-link signup opened 07-20. Read-only tabs are anonymous for the 5 published Flow collections; cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction was NOT re-measured this run** (DB/queue-only pass captured no user count). The **last confirmed reading (2026-07-26) is 20 users / 0 new signups / 0 WAU**, and no entry this week indicates movement — treat as presumed-flat pending a fresh capture.
- The reframe holds: the work is acquisition and retention, not instrumentation. The assets are built and idle: 30 `/insights` boards (both chain-two boards live), OG cards on every share surface, a working concierge (now with a real outcome-monitor), live alert loops.

Suggested next step: **re-capture the user/WAU count** (skipped this run), then pick **one** acquisition channel and run it against the 50+ gate. Still the single most important item in the whole report.

### 2.2 Public intelligence surfaces — 30 public — `Severity: n/a (shipped) · context`

All 30 built surface dirs in `app/insights/` are public; the two chain-two boards read their data directly and carry their mandatory honesty disclosures (Candy's LOW-confidence FMV; Panini's listing-gated "floor, not a census" banner + `meta.coverage`). IA reorg carried (Moments | Packs sub-toggle; Play hub). Market is edition-level, Sniper serial-level. **Carried risk:** the `deals`/insights refresher fails a large share of board-warm ticks under saturation, so some boards serve last-good snapshots up to ~2–3h old (surfaced honestly with an age stamp; nobody sees an empty board).

### 2.3 Data-intelligence — a correctness-and-regression week — `Severity: Medium (green; 2 operator items) · Effort: mixed`

**FMV HIGH/MEDIUM confidence share re-measured (per `metrics-latest.json`, 08-17):** Top Shot **52.8%**, All Day **24.5%**, Candy **60.0%**, Disney Pinnacle **40.7%**, Golazos **0.9%**, UFC **0.0%** (dead market — zero is the honest label). These reflect the full post-sweep state after the 08-08 confidence-accuracy program; the roadmap target "All Day → the Top Shot band or better" remains OPEN (both roughly tripled, so the ~2× gap holds).

**Fixed / shipped this week:**

- **The 161k-fabricated-row buyback bug.** A new NBA-buyback analytics board headlined **161,797** "buyback acquisitions"; the true figure is ~6. Root cause: `snapshot-institutional-wallets` offset-paged `wallet_moments_cache` with `.range()` and **no `.order()`**, so it read the right *number* of rows and the wrong *set* — duplicates and omissions roughly cancelled, so every count-based check passed for ~3 months. Fixed; `paginated-range-requires-order` is now a **ban at zero**.
- **#4 Pinnacle FMV ASK_ONLY drop — FIXED (2026-08-16).** A transaction-stable `NOW()` + `ON CONFLICT DO NOTHING` silently discarded the ASK_ONLY revision for 776 renders; changed to `DO UPDATE`, measured live to **0** disagreements, pinned both directions. (A smaller "a de-pricing writes no history row" case remains open, pinned as current behaviour — product call.)
- **The concierge 2-week outage.** ~780 conversations reported were degraded per the sibling monitor's own fixture, so the real user-facing figure was far smaller — but the concierge *was* degraded (Anthropic 403 `credit_balance`) with the smoke test reporting **ALL PASSED**, because the only probes were soft AND opt-in (paid). Replaced with an outcome-based check (share of real conversations that got a fallback), keyed on category not copy, hard, with a sample floor.

**Regressed / newly bit:**

- **#8 — `sync-nba-projections` has failed 100% of runs for 13 days on a sports-proxy `403`.** The instrument is *not* at fault (the 08-08 no_slate/all_upstreams_failed split is deployed and working); the cause is in the payload (`rolling_upstream_status: 403`, ESPN independently 403ing). ⚠ **It is the single root cause of three symptoms triaged apart:** projections 27.4d stale, the NBA player catalogue 101d stale (174 players / 19 of 30 teams), and `match-topshot-players` failing 100% since 08-14 (it has produced **zero** auto-aliases in its entire existence). **Fast Break reads the same catalogue, so it is on a 19-team roster now.** The lever is the 403 — **operator-only** (a proxy secret). Impact for projections is deferred to preseason (~Oct); for Fast Break it is live.
- **Panini `sale_price_capture_dry_days` arm is crying wolf.** The arm counts dry days on a field deliberately abandoned + replaced on 08-08 while the replacement works (capture 5% → 22.9% today on 17,809 rows). Like `ufc_fmv_stale_hours`, it can never go green and trains the operator to skim the board. Fix = **re-point** the arm (filed, not taken).

**Open / owed:**

- **D2b — P0 — rotate the pack-pipeline cron gate keys.** The code is de-hardcoded to fail-closed edge secrets, but the LIVE keys are still the burned values, reachable in git history. Setting a key to the value cron already sends is *service restoration, not rotation.* **Operator/Trevor-only** (runbook: `docs/handoff-2026-08-09e-edge-gate-key-rotation.md`; deploy needs both `--no-verify-jwt` and `--import-map supabase/functions/deno.json`).
- **FMV dust-filter *sale-floor* decision (`docs/fmv-dust-filter-decision-2026-08-02.md`) — ANALYSIS ONLY, hand-off-only.** FMV logic is Trevor's call.
- ⚠ **A monitoring gap named this week:** the platform has *cadence* coverage but essentially **no success coverage** — a watchlisted pipeline can fail 100% for days with every arm green, because a failing run still writes a `pipeline_runs` row. Cheap closer filed: an arm over `pipeline_runs_daily` for any watchlisted pipeline whose trailing-24h `ok_count` is 0 while `runs` > 0.

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (green; 1 P0 operator item) · Effort: landed`

- **Security posture GREEN.** `metrics-latest.json`: **0/0/0/0** — invariants, anon-write holes, rls-off base tables, secdef-anon drift all empty (re-verified live).
- **8 anon-executable INVOKER functions revoked** (population 84 → 78), including two pathological ones (`compute_pack_ev_from_pool_tier_weighted` ~45s / ~17 GB per call and `get_wallet_cache_count` ~39s, both zero-caller and anon-reachable). Severity was availability (unauthenticated compute on a 2 GB IO-budgeted instance), not confidentiality. A new guard (`migration-new-function-states-its-anon-exec-decision`) freezes the population; `check_secdef_anon_exec_drift()` is structurally blind to INVOKER functions, which is exactly how these hid.
- **The one real security debt is D2b (P0):** the gate keys in git history. Tracked, runbook exists, operator-only.
- **DB-invariant SQL layer grew 122 → 180 pins** over 179 distinct fns (172 `supabase/tests/*.sql` files incl. `_helpers.sql`; the drift-guard `PINS` array is authoritative). The scheduled-write surface was re-closed at 63/63; the drift guard now parses `CREATE OR REPLACE PROCEDURE`.
- **CI is 9 blocking jobs** (`.github/workflows/ci.yml`): `typecheck`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests`, `component-tests`, **`worker-tests` (NEW)**, `db-tests`, `ledger-guard`, `edge-deno`.
- **Coverage ratchets raised:** vitest primary **91.3 / 78.6 / 93.1 / 93.4**; component gate **90.3 / 81.6 / 89.1 / 93.2**; **new worker gate 85.1 / 72.1 / 83.8 / 88.1** (`workers/**`, previously measured by neither gate). **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low · Effort: ongoing`

The autonomous passes are queue-only when they cannot push (this run). **Hygiene flags:** (1) `docs/overnight/focus.md` is still dated **2026-06-24** — **~54 days stale**, describing a June studio-platform program as current, which is actively misleading for a launched, read-only, both-boards-public repo; (2) **`docs/overnight/ledger.md` holds 1,618 entries** (was 1,181); (3) **~35 consumed inbox files (Aug 9–14) remain un-archived** pending push restoration. The remaining standing operator blind spot is the **NO-PUSH git-credential failure** (§2.6). Sentry is live (0 new/regressed 48h).

### 2.6 Overnight operational queue — `Severity: Low–Medium · Effort: mixed`

Health is GREEN-with-known-saturation-noise. The three trust breaches at capture are all pre-known and non-regressive. Open items:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **NO-PUSH git credential (ESCALATED)** | Shell outage CLOSED, but the mounted clone's `remote.origin.pushurl` has no embedded credential → `git push` = "could not read Username" → **no overnight code deploys, no inbox archival.** | **Med–High (operator)** | Re-embed the PAT in the mounted pushurl, or restore cloud credential injection. |
| **candy-editions-ingest timeout-kill** | Silent ~2,847 min (missed the 08-16 daily tick and now a 2nd), a 300s `maxDuration` kill under saturation. A QUEUE-code fix is filed (`after()`-based route). | Med | CC-owned; NO-PUSH-blocked. |
| **fmv-recalc ~50%+ kill rate** | Over half of every invocation is killed at `maxDuration` under saturation (down from ~75% peak but not survivable). Now watched by `fmv_sweep_stall_pct_24h`; the wedge arm recovered to 0.39h at capture. | Med | Lever is page size per invocation, NOT raising `maxDuration`. |
| **DISK-IO MV-refresh cluster** | Several MV refreshes / heavy pg_cron jobs time out under saturation; `refresh_wmc_fmv_changed` is the #2 disk reader (the price of the wmc denormalization, not a defect). | Med | CC-owned; indexing + query narrowing. **Do NOT bump timeouts or upgrade the tier** — disk-IO-budget, not compute. |
| **PANINI price-capture dry 20d** | `panini_sale_price_capture_dry_days=20` (breach 3), +1/day — upstream residential-box outage since ~07-29 AND the arm is crying wolf on a replaced field. Re-point the arm; the capture itself works (~22.9% today). | Med (operator + re-point) | Operator/interactive on the runner box; arm re-point filed. |
| **sync-nba-projections 403 (#8)** | 100% fail 13 days; sports-proxy + ESPN 403. Root cause of 3 downstream symptoms (§2.3). | Med (operator) | Secret rotation/fix — operator-only. Do NOT retire (sole writer for `nba_players`/projections). |
| **ALLDAY unmapped backlog** | `unmapped_resolution_backlog_max=291` (breach 100) — AllDay permanent floor; D37 backlog grew 97,812 → 106,069 (+1,376/day), 64.6% correctly-held price-0. | Low (carried) | Ingest-capacity call; no autonomous fix. |
| **topshot-active-listings-ingest egress-blocked** | Atlas-WAF; ~60% of sweeps fail, one full day wrote 0 rows. The 17th worker `atlas-proxy` is shipped but INERT pending an operator `wrangler deploy` + egress probe. Starves a serial-alert feed + the concierge's "nothing listed" answer (now age-disclosed). | Low–Med (operator) | Do-not-suppress. |

### 2.7 Pack EV / pack-viz — `Severity: Low (honest by construction) · Effort: landed`

Carried. Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. A rebuilt `v_pack_pipeline_health` view landed this week (both collections, `reltuples` estimates, cheap) after the old one was Top-Shot-only, cry-wolf, and un-runnable. `compute-pinnacle-pack-ev` has been 100% failing since 08-11 with the fix never deployed (register R5 — operator secret + CC), freezing Pinnacle `pack_ev_history` ~98h stale with 22 of 81 dists still carrying a stale `+EV` flag.

### 2.8 Chain foundation — abstraction closed; BOTH expansions PUBLIC — `Severity: Low (shipped) · Effort: landed`

- **Chain-abstraction Phases A–F complete;** all 18 re-export shims deleted 07-25. New code imports canonical `@/lib/chains/flow/...` only.
- **Candy / Solana — PUBLIC since 2026-07-31** (`CANDY_MLB_PUBLIC = true`, verified). Rollback = flag flip.
- **Panini — PUBLIC since 2026-08-01** (`PANINI_PUBLIC = true`, verified). Listing-gated coverage disclosure travels with the surface. Rollback = flag flip.
- **17 Cloudflare worker dirs** (verified); `atlas-proxy` (the 17th) remains **INERT** pending operator deploy + egress probe.

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** (2026-08-01) — verified this run: `lib/cart/`, `lib/trade-escrow/`, `app/dashboard/{trade-hub,gift}/`, and `app/api/{cart,trade-chain,trade-hub,gift}/` all **absent**. Inert Cadence templates kept as data; DB tables untouched. The product is purely read-only.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues; "D…"/"R…" = the deep-audit register. **§9 has the verified open/resolved status of every numbered item.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** Public + self-serve ~4.5 weeks; last-measured **20 users / 0 WAU** (not re-measured this run). The gap is demand, not measurement. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| 0 | **Wallet verification.** RPC asks only for a public identifier (address / username) and reads view-only; the working self-serve path is the listing challenge (`resolve_wallet_challenge_match`, +500 credits). "Sign in with Dapper" was **removed by decision**. | Low–Medium | (mostly resolved-by-removal) |

### Deep-audit register — open findings (run 2, 2026-08-15)

| id | Issue | Severity | Owner |
|---|---|---|---|
| **D2b** | **Rotate the pack-pipeline cron gate keys** — secret-exposure half untouched; live keys reachable in git history. Runbook exists. | **P0** | **Trevor (secrets)** |
| R5 | `compute-pinnacle-pack-ev` 100% failing since 08-11; the fix (`bd53bb3a`) was **never deployed**. Pinnacle `pack_ev_history` ~98h stale, 22/81 dists carry a stale `+EV` flag. | P1 | Trevor (secret) + Claude Code |
| R6 | `get_collection_stats` still times out on All Day (2,230 LATERAL loops vs TS 769). The `computed_at <= now()` mitigation cut ~20% but is not a rescue; real fix is a precomputed latest-FMV-per-edition materialization. | P1 | Claude Code |
| D8 | wmc metadata denorm self-heal — **TS + UFC drained** (row-lock contention, chunk it), AllDay residual ~284 is mostly the R8 "editions with no name" class that no wmc backfill can fix. | P1 → partial | Claude Code + operator |
| R10 | `openGraph`/`twitter` shallow-merge trap live in 3 shared helpers (`pageMetadata`/`buildMeta`/`collectionLayoutMetadata`) → ~30 insights layouts unfurl with no X byline. | P2 | Claude Code |
| R12 | `/share/<wallet>` renders a failed read as "your wallet isn't indexed yet" (self-fetch → null → empty-state); no `alternates.canonical`. | P2 | Claude Code |
| R13 | `/api/profile/achievements` POST is a confused deputy (body `ownerKey`, no `requireOwnedKey`); GET returns `[]` at 200 on error (D11 class). | P2 | Claude Code |
| R14 | 2 `function_search_path_mutable` advisor WARNs — verified harmless; `ALTER PROCEDURE … SET search_path` prepared, deliberately NOT applied (batch with next DDL window). | P2 | Claude Code |
| D37 | AllDay `unmapped_sales` backlog GREW 97,812 → 106,069 (+1,376/day); 64.6% correctly-held price-0. Ingest-capacity call. | P2 | Claude Code |
| D31 | Migration-parity backlog regressed (prod 2,544 vs 539 committed); 1 real fileless migration (`20260814045645`), recoverable byte-exact from `schema_migrations`. | P2 | Claude Code |
| D21 | AllDay `edition_offers` bids median stale (improved 12.8d → 11.5d); benign skew, collection-gated, no cross-collection contamination. | P2 | Claude Code |
| D18 / D26 / D30 / D39 | Inert-schedule list still contaminated (do not act); 5 churning duplicate-slug player fossils (do not "fix" the data); 3 production-dead components (cleanup); `check_unmapped_backlog_growth()` no cache-age guard (latent). | P2–P3 | Claude Code |
| R4 / R8 / R9 | **Re-pointed as wrong-as-filed** — R4 is a catalog-coverage gap not an indexer regression; R8's prescribed heal would write TEAM names into `player_name` (DO NOT RUN); R9's homepage-multiplier finding was wrong (the file is accurate). | (re-pointed) | Trevor / Claude Code |

### Data-intelligence correctness / honesty

| Item | Issue | Severity | Effort |
|---|---|---|---|
| FMV confidence | Post-sweep HIGH/MED shares measured (§2.3). Roadmap "AllDay → TS band" still OPEN. | Medium | Ongoing |
| FMV dust-filter | `$0.50` sale floor inflates ~46% TS / ~76% AllDay editions. **Decision doc queued — hand-off-only, Trevor's call.** | Medium | Small (decision) / medium (unwind) |
| Panini price-capture arm | Crying wolf on a replaced field; re-point (filed, not taken). | Low–Med | Small (arm re-point) |
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine primary. Legacy `edition_key` is character-LOSSY — never repoint character reads onto it. | Medium | Medium |

### Cost / operational right-sizing

| Item | Issue | Severity | Effort |
|---|---|---|---|
| DB storage | **13,114 MB — UP ~742 MB** this week. | Low–Med | Small (monitor) |
| Disk-IO on SMALL instance | **The binding constraint** — drives fmv-recalc kill rate, deals-board staleness, `get_collection_stats` timeout, pg_cron statement-timeouts. Fix expensive queries / precompute; don't upgrade the tier. | Medium | Ongoing |
| Vercel cost family | Carried (Spend-Management cap backstop; Fluid/cron/observability levers). | Medium | Small–Medium |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | CLOSED — all 18 shims deleted 07-25. | n/a (resolved) | (landed) |
| Candy / Panini | Both PUBLIC (07-31 / 08-01). Rollback = flag flip. | n/a (shipped) | (landed) |
| `atlas-proxy` (17th worker) | Shipped but INERT — pending operator `wrangler deploy` + egress probe. | Low | Small (operator) |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 | Monolith page refactor — **the pages were SPLIT this week** into thin server `page.tsx` (11–28 lines) + `*Client.tsx`, so the component gate measures them. The bulk now lives in `CollectionTabClient.tsx` **1,331** / `SniperClient.tsx` **1,804** / `CollectionAnalyticsClient.tsx` **1,798** / `DashboardClient.tsx` **2,613** (measured this run). `CLAUDE.md` #14 (Phase 1 complete) is accurate; the client-page conversion + honesty ratchets are now the tracking mechanism. Plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (Phase-1 done; Phase-2 component splits remain) |
| 10 | `/dashboard` token migration — logic now in `DashboardClient.tsx` (**2,613** lines, measured this run). | Low | Large |
| 15 | `livetoken-portfolio*.json` scratch fixtures — RESOLVED (none git-tracked). | Low (resolved) | Trivial |

### Page polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack/Moment/Set tune-up. Deep-audit run 2 swept more entity/board defects (overview honesty panels, series soft-404, tier bucketing, `/share` self-fetch). Remaining lower-value tier: modal a11y, Set B5/B7, the deferred `/ufc-strike/*`→`/ufc/*` 301. Audit docs (`docs/archive/audits/{PACK,MOMENT,SET}_PAGES_AUDIT_2026-05-22.md`) are point-in-time. | Low–Medium | Medium (mostly done) |
| 11 | Brand punch list — token sweep complete; CI guard (`scripts/check-brand-tokens.mjs`, present, extended this week to ban the email accent on web surfaces + walk `app/**`+`components/**`). Remaining: longer-tail surfaces. | Low | Small |
| 12 | Blazers trivia — `lib/blazers-trivia.ts` verified **ABSENT** this run, yet `CLAUDE.md` #12 re-cites it ("29 items shelved, still no UI") → the reference is **stale**. Recommend closing/correcting the slot. | Low (stale ref) | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 / #3 / #3b | Cart / Trade Hub / Gifting — DELETED (2026-08-01), verified still absent. | n/a (removed) | n/a |
| — | Breaks — dormant (tables not in prod, migration unapplied). | Low (dormant) | n/a |

### Deferred hardening (intentional — from `CLAUDE.md`)

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each retain a `roles=public` INSERT policy. Future hardening: per-row size caps, a `created_at` rate-limit column/trigger, a `bot_score` column, possibly an edge rate-limiter.
- `user_achievements` + `watchlist_items` — service-role-only writes but still keyed on `owner_key` (text) rather than `user_id` (UUID).
- `badge_editions.low_ask` — **AllDay + Golazos RESOLVED**. `highest_offer` coverage remains the residual gap (Golazos has no offer source; a `golazos-offers-indexer` is staged but uncronned, gated on one on-chain recon).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design (long-form vs short-form; `HIGH|MEDIUM|LOW` vs `HIGH|MED|LOW`). Re-read `CLAUDE.md` before writing any new query. `docs/reference/schema-truth.md` (present) is authoritative for volatile schema facts.
- **Supabase compute is `SMALL` (2 GB / 2-core)** — saturation is disk-IO-budget-bound.
- **A function-level `SET statement_timeout` is INERT** — 195 `public` functions declare one, 47 above the global 120s; the binding budget is the caller's role, not the declaration. Do not "fix" a timeout by editing `proconfig`.
- **`evm_nft_transfers` holds ZERO rows** and its inert `evm-transfers-ingest` cron is disabled — the "1.01M Beezie transfers" claim in older docs is stale.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old 2026-05-24 two-item list is replaced by **`docs/strategy/roadmap-2026-08-03.md`** (verified present), now canonical (supersedes 07-18):

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM confidence share must beat the sites collectors already use before growth tactics return.** | Advancing — HIGH/MED shares measured post-sweep (TS 52.8% / AllDay 24.5% / Candy 60% / Pinnacle 40.7%); dust-filter *sale-floor* decision still queued. |
| 1 | **Prove the product with real users — the only user gate is 50+ WAU.** | **Open — the critical path.** Instrumentation done; last-measured 0 WAU; not re-measured this run (§2.1). |
| 2 | Cost / latency levers. | Advancing — disk-IO is the binding constraint (fmv-recalc kill rate, deals-board staleness, `get_collection_stats` timeout); DB +742 MB. |
| 3 | Durable debt. | **Heavy advance** — client-page conversion + honesty ratchets FINISHED; deep-audit run 2 drain; DB pins 122→180; 9-job CI. |
| 4 | Chain two, readiness-gated. | **DONE — both boards PUBLIC** (Candy 07-31, Panini 08-01). |

**Standing guardrails:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller.**

**Housekeeping still outstanding:** formally close the obsolete Flowty teardown priority in `CLAUDE.md` (API alive, feeds live ingest); correct #12 (Blazers trivia file is absent but re-cited); refresh `docs/overnight/focus.md` (~54 days stale).

---

## 5. In-code TODO inventory

A first-hand `ripgrep` scan over `app/ lib/ components/ workers/ supabase/ scripts/ docs/drafts/ proxy.ts` (node_modules/.next/.git excluded) found **no actionable markers in live application code** — unchanged in character from prior weeks. Breakdown:

### 5a. Candy launch-flag-gated "note" branches (2 markers) — keep by design

- `app/api/candy-sales-indexer/route.ts:160` and `app/api/ingest/candy-editions/route.ts:183` — `note: "…still a TODO_-prefixed placeholder"` strings inside launch-flag-gated defensive branches. Constants are filled; branches unreachable in practice. Not actionable.

### 5b. Solana readiness-guard refs (7 markers) — guard functions, not open work

- `lib/chains/solana/normalize.ts` (7) — the `startsWith("TODO_")` readiness-guard functions + their `TODO_n RESOLVED` narrative. Placeholder-guards, not open TODOs.

### 5c. Panini draft/reference lines (4 markers) — draft-only, all closed

- `docs/drafts/panini/panini-proxy/index.js:19` (`TODO(discovery) CLOSED 2026-07-19`) and `docs/drafts/panini/ingest-panini-runner.mjs` (×3, all `TODO(go-live) RESOLVED 2026-07-16/19`) — shelved draft scaffolding, all annotated resolved/closed.

### 5d. Narrative / false positives / test refs (rest)

- **~4 narrative/false-positive lines:** `lib/rtr-lock-roi-weights.ts:7` + `app/api/rtr/lock-roi/route.ts:38` ("resolves the standing … TODO"), `lib/format.ts:6` (`"$X,XXX.XX"` format doc), a v2 comment referencing "the v1 TODO", and a migration comment ("was a TODO in `CollectionMomentTable.tsx`"). All describe *resolved* work.
- **~2 test refs:** `__tests__/*` assertions that the `TODO_`-prefix readiness guards behave.

> **Net change since last week:** none of consequence. Live application code has zero actionable TODO markers.

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, `docs/audits/deep-audit-register.md`, and `docs/overnight/metrics-latest.json`:

**Known-issue slate (carried, still resolved):** #2 (Sentry SDK wired + connector live), #3 (Flowty event indexer — frontend shut, API alive), #4 (**Pinnacle FMV — ASK_ONLY drop FIXED this week**), #5 (AllDay/UFC mis-categorized — only 8 stray), #6 (WarmupContext key), #7 (AllDay `unmapped_sales` original defect), #13 (`flowty_archive` growth), #15 (scratch fixtures), #16 (`flow test` CI — expanded to 9 jobs), plus the fmv-recalc silent stall. ⚠ **#8 is REGRESSED, not resolved** — see §2.3/§9.

**Newly resolved / closed / shipped this week:**
- **The 161k-fabricated-row buyback bug** — `paginated-range-requires-order` now a ban at zero.
- **The concierge 2-week outage** — outcome-based smoke check landed.
- **Client-page conversion + honesty-ratchet workstream FINISHED** — client-page gate ratchet at floor (1), plus a broad sweep of the failed-read-renders-as-answer class.
- **8 anon-executable INVOKER fns revoked** (84 → 78) + a population-freezing guard.
- **8-way trust-precompute split** (pg_cron 85 → 93); per-leg freshness view isolates a failed leg.
- **#4 Pinnacle FMV ASK_ONLY drop fixed;** **D25 impossible-serials drained** (128 → 62); **R7 `drain-conflated-subeditions` resolved-in-prod (08-16);** **R1/R2/R3 deep-audit P0s+P1 shipped `8f59749b`.**
- **DB-invariant pins 122 → 180;** primary ratchet 91.3/78.6/93.1/93.4; component 90.3/81.6/89.1/93.2; **new worker gate.**

---

## 7. Suggested sequence

A pragmatic order under the **accuracy-is-the-gate** framing (`docs/strategy/roadmap-2026-08-03.md`):

1. **Restore the git push credential (§2.6) — operator.** With the shell back, this is the one thing still blocking all autonomous code shipping + inbox archival. Re-embed the PAT in the mounted pushurl (or restore cloud credential injection).
2. **Clear the two standing operator secrets — Trevor.** (a) **Rotate the pack-pipeline cron gate keys (D2b, P0)** — keys are in public git history and still live. (b) **Fix the sports-proxy 403 (#8)** — one secret unblocks projections, the 101-day-stale player catalogue, the matcher, and Fast Break.
3. **Drive traffic AND re-capture the WAU number (§2.1).** The only user gate is 50+ WAU; last confirmed 0, skipped this run. Pick one channel and run it. Still unambiguously the top product item.
4. **Un-stick the fmv-recalc / deals saturation cluster (§2.6).** ~50%+ of fmv-recalc invocations are still killed; the deals/insights refresher fails most board-warm ticks. Fix is a precomputed latest-FMV-per-edition materialization (also the fix for R6 `get_collection_stats`) — CC-owned, NO-PUSH-blocked.
5. **Put the FMV dust-filter *sale-floor* decision in front of Trevor (§2.3).** Highest-leverage correctness change still queued; hand-off-only.
6. **Re-point the two cry-wolf arms** (`panini_sale_price_capture_dry_days`, and add the success-coverage arm) so the trust board stops training the operator to skim.
7. **Doc hygiene:** refresh `docs/overnight/focus.md` (~54 days stale); in `CLAUDE.md`, close the obsolete Flowty priority and correct slot #12 (file absent but re-cited).
8. **Deep-audit tails as capacity allows** — R5 (Pinnacle pack-EV deploy), R6 (get_collection_stats materialization), R10 (og/twitter merge), D8 AllDay residual, D37 (AllDay unmapped tail).

---

## 8. Notes from verification

- **Shell GREEN this run (9-night outage closed).** Commit counts, line counts, path checks, and the TODO scan are all first-hand (`git log`, `ripgrep`, `wc -l`, `ls`). ⚠ **git PUSH is dead** (missing pushurl credential) — a *different* blocker than the last three reports' shell outage.
- **Commits measured:** `git log --since=2026-08-10` = **~843** (76/38/135/41/202/273 across Aug 11–16). HEAD `7fdc8436` (a docs commit, correctly CANCELED by Vercel `ignoreCommand`).
- **TODO scan: 0 actionable markers in live app code** (§5) — measured via `ripgrep` over the source tree. ⚠ Method note: a whole-repo `rg` with negated globs timed out twice (large SQL corpus); scoped scans per directory returned promptly and are the basis here.
- **Deletions verified by absence:** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `app/api/cart`, `app/api/trade-chain`, `app/api/trade-hub`, `app/api/gift` — all absent. **`lib/blazers-trivia.ts` verified ABSENT** (yet `CLAUDE.md` #12 re-cites it → stale ref).
- **Launch flags verified in `lib/launch-flags.ts`:** `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`.
- **Counts measured this run:** CI = **9** jobs (`.github/workflows/ci.yml`); DB pins = **180** (`PINS` array); `supabase/tests/*.sql` = **172**; primary ratchet **91.3/78.6/93.1/93.4** and component **90.3/81.6/89.1/93.2** (`vitest*.config.ts`); worker gate **85.1/72.1/83.8/88.1**; Vercel crons = **37** (`vercel.json`); worker dirs = **17**; `app/insights/*` dirs = **30**; monolith client files 1,331 / 1,804 / 1,798 / 2,613. pg_cron **93** is from `CLAUDE.md` (not DB-queried this run).
- **Cited paths spot-checked — all resolve:** `docs/strategy/roadmap-2026-08-03.md`, `_07-18.md`, `docs/fmv-dust-filter-decision-2026-08-02.md`, `docs/audits/deep-audit-register.md`, `docs/audits/deep-audit-2026-08-15.md`, `docs/audits/refactor-plan-monolith-pages-2026-05.md`, `docs/reference/schema-truth.md`, `lib/market-closed.ts`, `lib/insights/board-cache.ts`, `scripts/check-brand-tokens.mjs`, `docs/handoff-2026-08-09e-edge-gate-key-rotation.md`. `docs/FREEZE.md` **absent** → no active freeze.
- **`docs/overnight/focus.md` is ~54 days stale** (dated 2026-06-24). `docs/overnight/ledger.md` has **1,618** `### ` entries (was 1,181).
- **DB-side facts** (DB size **13,114 MB**, editions ~27,193, security 0/0/0/0, 3 trust breaches, FMV HIGH/MED shares, `stalled_pipelines`) come from **`docs/overnight/metrics-latest.json` (2026-08-17T08:10:00Z — same day, real-time from DB)** plus `CLAUDE.md`'s 08-15/16/17 entries. **Traction (user/WAU) was NOT captured** — last confirmed 20 users / 0 WAU (2026-07-26). **Sentry live** (0 new/regressed 48h; 6 issues all smoke-couldNotRun).
- **Deep-audit register reconciliation nuance:** the register's OPEN table still lists R1/R2/R3 with VERIFIED evidence, but `CLAUDE.md` #18 records the two P0s + the `/api/fmv` P1 as shipped in `8f59749b` — the register was not fully reconciled to that. This report treats R1/R2/R3 as resolved per `CLAUDE.md` and R7 as resolved-in-prod (08-16).
- **Autonomous-task caveat:** the daytime monitor and night pass run against this repo, so the working tree and the register may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` + `docs/audits/deep-audit-register.md` are the authoritative records.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-08-17)

Every slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | Resolved-by-removal | **Mostly resolved-by-removal** — Dapper sign-in deleted; listing-challenge is the self-serve path | `resolve_wallet_challenge_match` present |
| 1 | Cart execution | DELETED | **Removed from the tree (08-01)** | `lib/cart/`, `app/api/cart/` absent |
| 2 | Sentry inactive | Resolved | **Resolved** — SDK wired + connector live | metrics: 0 new/regressed 48h |
| 3 | Flowty indexer / Trade Hub | Resolved (Flowty) + DELETED (Trade Hub) | **#3 double-labelled** — Flowty resolved; Trade Hub deleted; contract + suite kept in CI | `lib/trade-escrow/` absent; `cadence-escrow-tests` job |
| 3b | Gifting | Removed | **Removed from the frontend (08-01)** | `app/dashboard/gift/`, `app/api/gift/` absent |
| 4 | Pinnacle FMV | Resolved (+ ASK_ONLY drop fixed 08-16) | **Resolved + enhanced** — per-render engine primary; ASK_ONLY drop fixed | `pinnacle_fmv_recalc_render_all.sql` pin |
| 5 | AllDay/UFC mis-categorized | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key | Resolved | **Resolved** | `lib/warmup/WarmupContext.tsx` present |
| 7 | AllDay `unmapped_sales` | Resolved | **Resolved (original defect)** — current 291/106k backlog is expected residue + inflow (D37) | metrics + register D37 |
| 8 | NBA stats unreachable | ~~Resolved~~ **RE-OPENED** | **REGRESSED 2026-08-16** — 100% fail 13 days on sports-proxy 403; root cause of 3 symptoms | `CLAUDE.md` #8 + §2.3 |
| 9 | Storefront audit pipeline | Retired | **Retired** | prior runs |
| 10 | `/dashboard` token migration | Open | **Open** — logic now in `DashboardClient.tsx` (2,613 lines, measured) | this run |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — token sweep + CI guard extended this week | `scripts/check-brand-tokens.mjs` present |
| 12 | Blazers trivia | Shelved (re-cites file) | **File ABSENT, but slot re-cites it → STALE REF** | Glob `**/blazers*` → none |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` |
| 14 | Monolith page refactor | Phase 1 complete | **Open — pages SPLIT** into `page.tsx`+`*Client.tsx`; bulk in Client files (1.3k–2.6k lines) | measured this run |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** — none git-tracked | prior runs |
| 16 | `flow test` in CI | Resolved | **Resolved — expanded to 9 jobs** (added `worker-tests`) | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set tune-up | Open (ongoing) | **Open — large deep-audit sweep continued** (overview honesty, series soft-404, `/share`); a11y + `/ufc-strike` 301 tail remain | register R1/R12 |
| **18** | **Deep audit run 2 (2026-08-15) open findings** | **Open (NEW slot)** | **Open** — R5/R6/R10/R12/R13/R14 + carried D-items; R4/R8/R9 re-pointed; R1/R2/R3/R7 shipped | `docs/audits/deep-audit-2026-08-15.md` + register |

**Tally:** 11 resolved (#2, #3-Flowty, #4, #5, #6, #7, #13, #15, #16, #12-by-removal, fmv-recalc stall) · **1 regressed/re-opened (#8)** · 3 removed from the tree by decision (#1 Cart, #3 Trade Hub, #3b Gifting) · 1 retired (#9) · 6 open or partial (#0, #10, #11, #14, #17, **#18 new**). Plus the live **deep-audit register** (run 2 — ~14 open incl. the P0 D2b), the **FMV confidence-accuracy** shares, **Candy + Panini public boards**, **9-job CI**, **180 DB-invariant pins**, and the **30 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** a few slots need a touch — **(a)** #8 should be formally marked **REGRESSED/re-opened** (100% fail on the sports-proxy 403, three downstream symptoms) rather than sitting under Resolved; **(b)** #12's slot re-cites `lib/blazers-trivia.ts`, which is **absent** — correct or close it; **(c)** #3's numbering collision persists (retiring the slot is cleaner than renumbering); **(d)** the new **#18** deep-audit slot is tracked here. Standing recommendations still hold: close the obsolete Flowty priority and refresh the ~54-day-stale `focus.md`. Two things genuinely need a human this week beyond the standing operator secrets: **(1)** restore the **cloud sandbox's** git push credential — measured 2026-08-17 from Trevor's local box, `git push` **works** (the rejection there was fast-forward, not auth), so this blocks the *autonomous overnight pass only*, not interactive shipping — and **(2)** action the **P0 gate-key rotation (D2b)** and the **sports-proxy 403 (#8)**. And the top-line framing is unchanged: with the site public and self-serve open ~4.5 weeks, the last confirmed reading is **20 users / 0 WAU** (un-remeasured this run) — **demand is the one number that decides everything**, and it has not visibly moved.
