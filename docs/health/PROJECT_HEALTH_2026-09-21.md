# Rip Packs City — Project Health Report

**Date:** 2026-09-21
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (Open § + STATUS INDEX, now reading **131 numbered items — 63 open · 18 partial · 50 closed**, running `#0–#133`, current through the 2026-09-20 entries), `docs/reference/roadmap-status.md` (live HEADLINE-METRIC block **2026-09-18 27-leg series**), `docs/strategy/go-live-2026-09.md` (M1–M11 bars + B1–B5 blockers), `docs/overnight/metrics-latest.json` (captured **2026-09-20 ~01:10 AM PT**, genuine overnight), `docs/overnight/ledger.md` (newest heading 2026-09-20), plus first-hand file-tool + shell scans (`git`, `grep`, `wc`) and **live DB reads (2026-09-21)** for demand, accuracy and DB size.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#133`), the go-live bars, the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-09-14.md` (7 days ago). This regeneration mirrors its structure. `_2026-09-07.md` … `_2026-05-22.md` (twenty prior reports) also live in `docs/health/`.

> **✅ Tooling note — the sandbox shell is BACK, and so is push.** Last week's report opened on six straight nights of NO-PUSH (the Sept-8 Windows update had killed the Plan9 mount). That is over: `mcp__workspace__bash` mounts normally this run, `git`/`grep`/`wc` all work, and the nightly pass reports itself **push-capable via the `.rpc-git-cred` credential store** (`git push --dry-run` exits 0). So every count in this report is first-hand and current — commit counts, line counts, live DB reads — none is flagged "unavailable" as it was a week ago.

> **⚠ Date nuance.** The harness stamps today **2026-09-21**. Demand, accuracy and DB-size figures below are **live reads taken 2026-09-21 (PT)**; the overnight operational figures come from `metrics-latest.json` captured **2026-09-20 ~01:10 AM PT**. The accuracy SERIES is the 27-leg `rpc_trust_health_history` read of **2026-09-18**; single-leg confirmations taken today are labelled as legs, never as levels. Ledger/session dates are Pacific. Filed under **2026-09-21** per the weekly-regeneration convention (prior report 09-14, exactly 7 days back).

> **Report location stays clean.** All twenty-one reports (this one included) live in `docs/health/`; the repo root holds none.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/strategy/go-live-2026-09.md` for the go-live plan. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-09-14 — last week's two "wrong-way" operational axes both REVERSED, and the platform's binding constraint was lifted.** Seven threads. **(1) The DB compute tier was resized SMALL → LARGE on 2026-09-20 ~10:40 AM PT** — the disk-IO ceiling on a 2 GB / 2-core instance was the structural cause behind five straight days of M11 saturation spells last week; that ceiling is now materially higher. **(2) DB storage REVERSED: 30,574 MB → 19,759 MB live (−~10.8 GB, −35%)** — #75 (the `net._http_response` ~13 GB pg_net store) was CLOSED 09-20 and retention applied, undoing last week's +68% alarm. **(3) The live trust breach is GONE** — `topshot_impossible_parallel_serials` read 36 last week; it reads **0** today, verified under the guarded writer 09-14 12:06 PM PT (#82). `public_board_slow_count` also fell 3 → 0. **(4) NO-PUSH cleared** — the shell and push are back; **731 commits** landed since 09-14 (vs "unavailable" a week ago), the autonomous pass is shipping again (4 the last night, ~30 the night before). **(5) The gate-key rotation finally COMPLETED (09-20)** — all six de-hardcoded functions deployed, three lanes rotated onto keys that were never public, and the rotation procedure's own leak vector removed (#32 closed). **(6) A large fabricated-zero defect was found and drained** — #128: 82,864 Top Shot pack rips (28.4% of valued rips) carried a fabricated `pull_value_usd = 0` that had defeated the 2026-08-01 read-layer fix from the write side; one dist page had published **$0.05** average realized value for a pack averaging **$80.19** of pulls. Both writers fixed, rows drained, the whole class swept clean (79 candidate sites → 19 write-side → 0 live). **(7) M2's stated blocker relaxed** — All Day weekly sales went 938 → 5,269 (the NFL season, not a code lever); M2 now touches the 30% bar on single legs but the 27-leg series (28.7% mean, 6 of 27 at/over) still reads NOT MET.

> **Overnight reality — ACTIVE and shipping again.** The 2026-09-20 pass (`rpc-nightly-autonomous-pass`, Cowork cloud) shipped **4**, reverted **0**; the night before shipped ~30. Verdict: **HEALTHY, NO REGRESSION.** Security **4/4 clean** (invariants `[]`, anon-write `[]`, rls-off-base-tables `[]`, secdef-anon `[]`); structural drift all arms `[]`. **Trust breaches: 0** (last week 1). **Stalled pipelines: 1** — `pinnacle-metadata-backfill` invoked-but-never-logged, chronic cadence-only lane, not new. `sentry_new_24h` 0, paired with Vercel = all chronic shapes, no new error class. The one open cron-cost item is **#126** (fleet busy-seconds up ~10× since 09-15), decomposed to the Atlas sync family + jobid 303 wmc-fmv-changed — a product/architecture decision, not an autonomous lever.

> **Traction reality — WAU still 1 (live read 2026-09-21).** **28 accounts (+3), WAU 1, MAU 8, 135 saved wallets (+21 from 114)**, 0 email subscribers, 27 of 28 users have a saved wallet. Accounts and saved wallets grew modestly; **WAU is flat at 1 against a 50+ gate and remains the one number that decides everything.** The accuracy gate reads per-collection: **Top Shot MET on the series (53.1% mean / 55.3 today)**, **All Day NOT MET (28.7% series mean / 30.7 today — a single leg at the bar, not a level)**, Candy ~58%, Pinnacle 27.6, Golazos 0.7%, UFC 0.0% (sentinel).

> **Cost / storage — DOWN, SHARPLY, reversing last week.** DB is **19,759 MB live (2026-09-21)**, down **~10.8 GB (−35%)** from last week's 30,574. Driver of the reclaim: **#75 CLOSED 09-20** (the 13 GB `net._http_response` store gone), plus retention. The **SMALL → LARGE compute resize (09-20)** lifts the disk-IO ceiling that made saturation structural. Vercel build compute (#61, M10) is still to be re-measured at the next invoice; the 09-10 spend-cap pause (#76) is resolved (budget raised).

> **Platform context (largely unchanged).** **(1)** Top Shot's public REST API stays dead; the Atlas backend read from the DB is the feed (#65). ⚠ **New this week: Atlas `SearchMarketplaceTransactions` now answers a Cloudflare JS challenge (403) to both the GitHub runner and Trevor's residential IP** — it needs a new transport, not a restart (#125, fix shipped 09-19, one operator command owed). **(2)** Flowty frontend shut, API alive feeding ingest. **(3)** NFL All Day secondary-market only — **sales volume recovered with the NFL season** (938 → 5,269/wk). **(4)** UFC Strike Flow market frozen (0 sales in 90 days; honestly labelled). **(5)** Candy / Solana LIVE, thin. **(6)** Panini decided = WC Prizm plane; ⚠ **`ingest-pinnacle-mints` has 403'd every dispatch since 09-20 11:40 AM PT** — a `?key=`-gated function deployed before its secret; Pinnacle mint capture stopped, one Trevor secret owed (#130).

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only) and the nightly pass run against this repo; shared state is in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` (absent this run → no freeze) halts all autonomous shipping. **Check `docs/overnight/ledger.md` and `docs/reference/known-issues.md` before acting.**

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#133** | Register STATUS INDEX: **131 numbered items — 63 open · 18 partial · 50 closed**. ~20 new slots (#114–#133) since last week's `#0–#113`. See §9. |
| Known issues — resolved/closed since last week | **~8** | **#32** (cron-ops card saved), **#75** (net._http_response gone), **#121** (`rpc_ops_snapshot` 659 ms warm), **#122** (09-18 outage), **#124**, **#126** (cron busy-seconds resolved after resize), plus #82's live breach cleared. — §6 / §9 |
| Known issues — open / partial | **~81** | 63 open + 18 partial per the index. New this week: #116–#120, #123, #125, #127–#133. — §3 / §9 |
| Known issues — 🚨 live trust breach | **0** | **#82 CLEARED** — `topshot_impossible_parallel_serials` 36 → **0** (live 2026-09-21), verified under the guarded writer 09-14. Last week 1. — §2.4 |
| Known issues — needs Trevor, operator | **several** | **#22** purge GC + rotate (still owed); **#55** both 2-hourly Routines still `enabled:false` (last fire 09-01); **#130** one Supabase secret (`PINNACLE_MINTS_GATE_KEY`); **#123**/**#131** operator `wrangler deploy` + ingest dedup; **#126** cron-fleet architecture decision. — §2.6 |
| Known issues — regressed / measured-dead (carried) | **1** | **#8 sports-proxy 403** — measured dead; suppressed to 2026-10-14, deferred to preseason. — §2.3 |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent this run. |
| Go-live plan | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md`. Met: M1 (on the series), M3, M6, M7, M9. Below bar: M2, M4, M5, M8, M10, M11 (relaxed by the resize). — §2.1 |
| Commits since last report | **731** | `git log --since 2026-09-14` (shell restored). Authors: Claude/Cowork/Opus 5 ~493, Trevor ~234, autorecover bot 3. |
| Accuracy gate (headline metric) | **Series, per collection** | Top Shot **MET — 53.1% mean over 27 legs (44.8–59.2, 23/27 ≥ 50%)**, 55.3 leg today; All Day **NOT MET — 28.7% mean (24.3–31.7, 6/27 ≥ 30%)**, 30.7 leg today; Candy ~58%; Pinnacle 27.6; Golazos 0.7%; UFC 0.0% (sentinel). Read the series, never a leg. |
| Demand (the critical-path number) | **WAU 1 · 28 accounts · 135 saved wallets** | Live 2026-09-21. Flat WAU. MAU 8. Gate: **50+ WAU**. — §2.1 |
| Open overnight operational items | **standing queue** | #126 cron-fleet cost (Trevor/architecture); #22 purge residue; #55 disabled Routines; #130 Pinnacle-mints secret; #125 Atlas transport; #123/#131 operator deploys. — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana LIVE thin + Panini (WC Prizm, bridge pending). Unchanged. — §2.8 |
| Prioritized next actions | **superseded** | `docs/strategy/roadmap-2026-08-03.md` (accuracy-is-the-gate) + `go-live-2026-09.md`. Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **0 actionable in live app code** | Measured this run (`grep`): 4 narrative/false-positive refs, +2 candy launch-flag "note" branches, +6 solana readiness-guard refs, +draft-doc resolved/closed lines. — §5 |
| Test / DB-invariant pins | **196 `supabase/tests/*.sql` files** | +3 vs last week's 193 (measured this run, `ls`). |
| CI jobs (ci.yml) | **19** | Measured this run: +1 vs last week (added `inherited-status`). See §8. |
| Public `/insights` surfaces | **30** | Measured this run: 30 `app/insights/*/page.tsx` dirs (flat). |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU. |

**Health read:** This was the week the operational risks that dominated the last report got fixed, and the front-page numbers barely moved. On demand — **WAU is still 1 against a 50+ gate**, the whole ballgame, unchanged. On accuracy — **Top Shot is MET on the 27-leg series and All Day is NOT MET but its blocker relaxed** (the NFL season restored All Day sales volume from 938 to 5,269/week, so M2 now touches the bar on single legs; the honest next step is to re-read the series after a full NFL week). Underneath, three of last week's four descending risks reversed: the **DB compute tier was resized SMALL → LARGE** (lifting the structural disk-IO ceiling behind the five-day M11 spell), **DB storage fell 35%** to 19.8 GB (with #75's 13 GB store gone), and the **live trust breach cleared** (0 today). The **NO-PUSH is over** — 731 commits landed and the autonomous pass ships again. What replaced them are correctness finds and operator hand-offs: **#128** (82,864 fabricated-zero pack rips, one dist publishing $0.05 for an $80 pack, now drained and the class swept clean), **#129** (Market-tab filters silently ignored on 4 of 5 collections while the UI counts them active — half fixed), **#130** (a `?key=`-gated Pinnacle function deployed before its secret, mint capture stopped, one Trevor secret owed), and **#131** (Candy boards double-counting listings — view half fixed). Descending, concentrated risk now: **(1) demand** — WAU 1, unchanged and still everything; **(2) the cron-fleet cost** (#126, ~10× busy-seconds, a Trevor architecture call now that the resize bought headroom rather than a fix); **(3) the operator hand-offs** — #130 secret, #55 disabled Routines, #22 purge rotation, #123/#131/#125 deploys; **(4) the honesty/correctness backlog** the audit cadence keeps surfacing (#128's residuals, #129/#131 open halves).

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public + self-serve ~10 weeks. **WAU 1 / 28 accounts / 135 saved wallets (live 09-21).** Accuracy at/around its bars. The problem is still *demand*. Gate: **50+ WAU** (§2.1) |
| **DB tier resized + storage reclaimed (REVERSAL)** | Compute SMALL → LARGE (09-20); storage 30.6 → 19.8 GB (#75 closed). M11's structural constraint lifted. The residual is cron-fleet cost #126 (§2.6) |
| **Live trust breach CLEARED** | #82 `topshot_impossible_parallel_serials` 36 → 0, guarded writer verified 09-14; `public_board_slow_count` 3 → 0 (§2.4) |
| **NO-PUSH cleared** | Shell + push restored; 731 commits since 09-14; autonomous pass shipping (4/night) (§2.6) |
| Data-intelligence correctness / honesty | #128 (82,864 fabricated-zero pack rips drained; write-vs-read fabrication class swept clean), #129 (Market-tab filters silently ignored on 4/5 collections), #131 (Candy boards double-counted), #93 (partly resolved), #67 (TS sales recovery) (§2.3) |
| **M2 blocker relaxed** | All Day weekly sales 938 → 5,269 (NFL season); M2 touches the 30% bar on legs, NOT MET on the series — re-read after a full clean NFL week (§2.1 / §2.3) |
| Gate-key / secrets hygiene | #32 rotation COMPLETED (six functions, three lanes, leak vector removed); #130 a `?key=` function deployed before its secret (403s); #22 purge residue still owed; `INGEST_SECRET_TOKEN` rotation still owed (§2.4) |
| Instrument darkness / operator-owned | #34 Sentry dark (beacon is the detector); #80 GitHub schedule-event drop; #100 master alarm GHA trigger; #77 fleet alarm single-channel (§2.5) |
| Security | **4/4 clean** + trust breach cleared; #60 (can't revoke anon from net/cron schemas) carried, needs Supabase support (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent (§2.9) |
| Chain expansion — Candy LIVE, Panini decided | Candy `/candy-mlb/overview` LIVE thin; Panini = WC Prizm plane, mint-capture 403'd (#130) (§2.8) |
| Mobile layout (NEW instrument findings) | M6 re-measured 0/56 overflow at 390 px AND 320 px, pinned; residue = #132 (~3,900 sub-44px tap targets, a product trade) + #133 (two pills hit-test to another element on two boards) (§2.3) |
| SEO | #66 — the site has zero external links, so ~31K indexed pages rank on page N; off-platform, not code (§2.3) |
| Tech debt / refactor | Monoliths re-measured this run and all growing: DashboardClient **2,948** / CollectionAnalyticsClient **1,927** / SniperClient **1,849** / CollectionTabClient **1,494** / MarketClient **1,273** (now under `app/(collections)/[collection]/*`) (§3) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled: no offer source); `INGEST_SECRET_TOKEN` rotation still owed |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is two layers: **`docs/strategy/roadmap-2026-08-03.md`** (accuracy is the GATE — headline metric is the HIGH/MEDIUM confidence share) and **`docs/strategy/go-live-2026-09.md`** (what "through the gate" means in numbers: M1–M11 bars, B1–B5 blockers, read as a series). The only user gate remains **50+ WAU**.

### 2.1 Launch + activation — Top Shot MET on the series, M2's blocker relaxed, demand flat — `Severity: High · Effort: Medium (built + measured, needs traffic)`

The un-gate shipped 07-17; self-serve magic-link signup opened 07-20. Read-only tabs are anonymous for the 5 published Flow collections (+Candy overview); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction, live read 2026-09-21:** **28 total accounts (+3), WAU 1, MAU 8, 135 saved wallets (was 114)**, 0 email subscribers, 27 of 28 users have a saved wallet. WAU unchanged. n=1 is noise, not a trend.
- **Accuracy is a 27-leg series (`rpc_trust_health_history`, jobid 488), read 2026-09-18:** **M1 (Top Shot) 53.1% mean, range 44.8–59.2, 23 of 27 legs at/over the 50% bar — MET on the series.** **M2 (All Day) 28.7% mean, range 24.3–31.7, 6 of 27 legs at/over the 30% bar — NOT MET, but it now touches the bar.** Single legs today corroborate (M1 55.3, M2 30.7) — but the file's own rule is *read the series, not the leg*: 30.7 is the top of an oscillation, not a level.
- **M2's stated blocker relaxed.** The 09-10 finding was that M2 is liquidity-gated on All Day sales volume; that volume came back with the NFL season (weekly sales 938 → 5,269, trailing 5,842/7d vs ~392/day averaged over 30). **The six at-or-over-bar legs are all 09-14 or later.** That is a trend claim off 27 points and it is NOT a pass — the honest next step is to re-read the series after a full NFL week with no outage in it, then book M2. The code-side levers remain small (~+0.1 / +1.5 / +1.1–2.7 pt) and are not the lever.
- **Bar status (`go-live-2026-09.md` §3):** **Met** — M1 (on the series), M3 (0 fabricated-number surfaces on the new-user walk), M6 (0 horizontal overflow at 390 px AND 320 px, both pinned), M7 (client-error detector), M9 (verification gate gone). **Below bar** — M2 (28.7% series vs ≥30%, blocker relaxed), M4 (15–25 s cold vs ≤8 s), M5 (7.3 s warm vs ≤5 s), M8 (E2E smoke streak), M10 (Vercel build compute vs ≤40%, re-measure at invoice), M11 (DB saturation — **structurally relaxed by the 09-20 SMALL→LARGE resize**; re-read the spell count over a clean week on the new tier).

Suggested next step unchanged: **pick one acquisition channel and run it against the 50+ WAU gate.** Still the single most important item in the whole report.

### 2.2 Public intelligence surfaces — 30 public — `Severity: n/a (shipped) · context`

All 30 built surface dirs in `app/insights/` are public (measured this run: 30 `page.tsx`). Carried honesty risks: `#50` (`/insights/pack-reality` "Honest +EV ranker" — its "N packs would otherwise qualify" line was corrected 09-20 from a counterfactual (3) to a measurement (2)), `#33` (ISR bakes a failed read into the `revalidate` window). New this week: `#129` (Market-tab Set/Series/Player/Min-price filters silently ignored on 4 of 5 collections while the UI counts them active), `#131` (Candy boards double-counted listings).

### 2.3 Data-intelligence — a large fabricated-zero drain, Market-tab filters, accuracy holding — `Severity: Medium–High (correctness finds) · Effort: mixed`

**FMV HIGH/MEDIUM share (series, per collection):** Top Shot **53.1% mean (MET)**, All Day **28.7% mean (NOT MET, blocker relaxed)**, Candy **~58%**, Pinnacle **27.6**, Golazos **0.7%**, UFC **0.0%** (empty-market SENTINEL, never a percentage). ⚠ Top Shot's level reflects the 09-08 denominator retirement plus the sales-ledger recovery working through the 30-day window; read the series, not a leg.

**Shipped / found since last week:**

- **`#128` — 82,864 Top Shot pack rips carried a fabricated `pull_value_usd = 0` (28.4% of every valued Top Shot rip), and it had defeated the 2026-08-01 read-layer fix for this exact defect from the write side.** `pack_rips.pull_value_usd` has two writers; one was pinned all-or-nothing since 09-12, the other (`backfill_pack_rip_metadata`) read `COALESCE(SUM(fmv_usd), 0)` and wrote a fabricated 0. A fabricated 0 is not absent — `count()`/`sum()` include it — so `mv_topshot_pack_realized_ev` and the pack-EV ranking published it. One dist page (`/nba-top-shot/pack/dist/8753`) had shown **$0.00 realized** for a pack averaging **$80.19** of pulls; another **$0.05** avg realized over 1,213 opens. **Fixed in four attributable migrations**, both writers made all-or-nothing + whole-pack, the 82,864 drained (~93% repriced to a value already held, the rest cleared to honest NULLs), the nine zero-mean dists cleared and verified on the board. **The whole class was then swept** per CLAUDE.md's rule: 79 candidate `COALESCE(SUM(...),0)` functions → 19 write-side → **0 live defects** (the most dangerous-looking survivor, `aggregate_saved_wallet_stats`, checked clean). ⚠ **Residuals open:** ~3.6% legacy partial sums preserved; ~82,200 zeros still draining at ~75/tick (~46 days) with no surface disclosing the in-progress dilution on 162 dists.
- **`#129` — the Market tab's Set / Series / Player / Min-price filters are silently ignored on 4 of 5 collections while the UI counts them as active.** They apply only inside the legacy `cached_listings` fall-through; Top Shot, All Day, Pinnacle and Candy return from modern arms before reaching it. **Pinnacle + Candy fixed at source** (and unified into one `applyBrowseFilters` implementation); **Top Shot + All Day need RPC parameters** (a `DROP`+`CREATE` migration on `get_topshot_sniper_deals` / `get_allday_market_editions`, not in-memory filtering of a truncated window). Deliberately not done at the end of a long session — the recipe is recorded in the item.
- **`#131` — both Candy boards returned the same listing twice**, inflating every count taken from them (`candy_market_board` +8.7%, `candy_deals_board` +19.5%). **View half fixed** (bounded `LATERAL` join, `security_invoker=on` re-verified); **ingest half open** (2 mints hold two active `candy_listings` rows — a stale listing never deactivated).
- **M6 mobile layout re-measured 2026-09-20/21:** **0 of 56 pages overflow at 390 px AND 0 of 56 at 320 px** (a width M6 never covered), both now pinned (`e2e/mobile-layout.spec.ts` 17/17 green on prod). ⚠ The sweep surfaced two product-call residues: **#132** (~3,900 sub-44px tap targets, down from 5,113 — full-width board rows that clear 24px and miss 44px by 6–19px, a scroll-vs-reach trade) and **#133** (two filter pills on `/insights/set-squeeze` and `/insights/offer-spread` hit-test to another element, pre-existing, undiagnosed).

**Carried / open:**

- **`#8` — sports-proxy `403` remains MEASURED DEAD.** Alarm suppressed to 2026-10-14; projections deferred to preseason (~Oct). Operator-only. Do NOT retire (sole writer for `nba_players`/projections).
- **`#66` — SEO:** zero external links, ~31K indexed pages rank on page N. Off-platform authority problem, not a code fix.
- **`#67` — TS sales-ledger recovery** carried; forward-recovered from Atlas, historical pacing (jobid 481) unscheduled.

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (green scans; 0 live breaches) · Effort: mostly landed`

- **Security scans GREEN, 4/4 clean** (invariants `[]`, anon-write `[]`, rls-off-base-tables `[]`, secdef-anon `[]`; re-verified 2026-09-20).
- **✅ The live trust breach cleared.** `#82` `topshot_impossible_parallel_serials` read 36 last week; it reads **0** today (live 2026-09-21), verified under the guarded writer 09-14 12:06 PM PT. `public_board_slow_count` fell 3 → 0.
- **✅ `#32` gate-key rotation COMPLETED (09-20)** — all six de-hardcoded functions deployed, three lanes rotated onto keys that were never public, and the rotation procedure's own leak vector removed.
- **🚨 `#130` (NEW) — `ingest-pinnacle-mints` has answered 403 to every pg_cron dispatch since 09-20 11:40 AM PT: a `?key=`-gated function was deployed (v26, fails-closed) before its secret was set.** Pinnacle mint capture (forward + backfill) is stopped; nothing corrupts (cursors hold, next good tick resumes). **Fix: one Trevor `supabase secrets set PINNACLE_MINTS_GATE_KEY=…`, no redeploy.** This is the 2026-08-12 `backfill-topshot-pack-supply` break repeated 39 days later.
- **`#116` (open) — a base-edition serial anomaly the trust metric is blind to.** 1,727 base-edition `sales` rows carry a serial their own edition cannot contain, over 73 editions; the metric is parallel-scoped (`external_id ~ '::'`) so reads 0. Three hypotheses tested and refuted; two authority pairs (`sales`+`moments` vs `circulation_count`+`wmc`) disagree, and the lead is an exact-zero constraint signature. **Decisive next step (a chain read for named moments) not yet taken.** ⛔ Do NOT widen the trust metric to base editions, and NEVER `raise_impossible_parallel_circ()` (274 audited attempts, 0 legitimate repairs).
- **`#83` (partial):** decoder no longer writes the custodian; 9,486 existing rows still name it — backfill owed.
- **`#60` (carried):** Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas; real fix needs Supabase support.
- **🚨 `#22` — the credential-purge residue is NOT cleared.** Branch deleted 09-07 (register marks closed) but the pre-purge blob stays fetchable by SHA until GitHub GCs it; the metrics queue still lists "#22 purge residue GC + rotate" as owed. **Rotate the credential regardless.** `INGEST_SECRET_TOKEN` rotation (~15 functions) also still owed.
- **DB-invariant SQL layer: 196 `supabase/tests/*.sql` files** (+3, measured this run). CI is **19 jobs** in `ci.yml`. **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

⚠ **`#34` — Sentry dark since 2026-08-18; no-spend DECIDED** — the `window.onerror`/rejection beacon → `usage_events.client_error` (per-tab `sid`, bot-filtered alert arm) is the detector. ⚠ **`#80` — GitHub dropped all schedule events for 2.8 h (09-10) and every watcher went blind** (partly mitigated). ⚠ **`#77` — the fleet alarm was single-channel (Telegram-only) and mute**; **`#100` — the master alarm's GHA trigger fires only ~27–29% of scheduled** (decided: move off GHA / stop hourly). ⭐ **`#62` — true-mobile QA instrument** (`scripts/qa/mobile-sweep.mjs`, real Chromium at 390/320 px) is the only real mobile instrument, and it earned its keep this week catching #132/#133.

### 2.6 Overnight operational queue — `Severity: Low–High (mixed) · Effort: mixed`

Health scans GREEN (0 stalled pipelines that are new; 1 chronic). The two axes that regressed last week both reversed. Open items:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **#126 — cron fleet busy-seconds up ~10× since 09-15** | Atlas sync family (~87k s/day) + jobid 303 `refresh_wmc_fmv_changed` (28.3k s/day, #1 FMV reader) dominate. Per-pipeline control: the 5 filed lanes are **0 of 34 failed** since the resize. | **Med–High (architecture)** | Product/architecture decision, not an autonomous lever — Trevor's. The 09-20 resize bought headroom, not a fix. |
| **#130 — `ingest-pinnacle-mints` 403s** | `?key=`-gated function deployed before its secret; mint capture stopped. | **High (operator)** | One `supabase secrets set PINNACLE_MINTS_GATE_KEY=…`; no redeploy. |
| **#55 — both 2-hourly Routines `enabled:false`** | Last successful fire 2026-09-01; cloud Routine binding immutable, re-create on Trevor's box with `requires_local_device`. | Med (operator) | One click on one machine; re-verified still disabled. |
| **#22 credential purge** | Branch deleted; blob still fetchable by sha; rotate regardless. | **P0 (operator)** | GitHub GC + credential rotation; `INGEST_SECRET_TOKEN` too. |
| **#125 — Atlas transport 403** | `SearchMarketplaceTransactions` now returns a Cloudflare JS challenge to runner + residential IP. | Med (operator) | Fix shipped 09-19; one operator command owed. |
| **#123 / #131 — operator deploys** | `workers/pack-events-ingest` `wrangler deploy` (seller fix); Candy listings ingest dedup. | Med (operator) | Cowork cannot push worker code. |
| **#8 sports-proxy 403** | Measured dead; alarm suppressed to 2026-10-14. | Med (operator, deferred) | Do NOT retire. |

### 2.7 Pack EV / pack-viz — `Severity: Medium (correctness find, drained) · Effort: mostly landed`

Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. **#128's fabricated-zero drain corrected the Top Shot realized-EV path** (see §2.3) — the largest pack-EV correctness fix in weeks; residual dilution on 162 dists is draining but undisclosed on-surface. The `compute-*-pack-ev` edge functions remain in the drifted set (operator-gated redeploy). The `buildTopshotPoolPayload` `|| 1` fabricated-divisor stays LATENT (0 degenerate distributions; its only caller, jobid 16, inactive) — the EXIT is to emit no rows at `totalCount === 0` when the pool lane revives.

### 2.8 Chain foundation — Candy LIVE, Panini decided — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — LIVE, THIN:** `CANDY_MLB_PUBLIC = true` (verified this run), overview tab only. ⚠ Board-dedup fix landed this week (#131); ingest-side listing dedup still open.
- **Panini — DECIDED = the WC Prizm plane** (`PANINI_PUBLIC = true`, verified this run). ⚠ **Mint capture is stopped (#130) pending one Trevor secret.** `#58` (`OPENSEA_API_KEY`) remains moot under this decision.
- **Chain-abstraction Phases A–F complete.** Cloudflare worker dirs carried (not re-counted).

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** — verified this run by absence: `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift` all absent. The product is purely read-only.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/resolved status of the items that moved this week.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** Public + self-serve ~10 weeks; **WAU 1 / 28 accounts / 135 saved wallets (live 09-21)** — flat. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| — | **Go-live bars M1–M11.** Met: M1 (series), M3, M6, M7, M9. Below bar: M2, M4, M5, M8, M10, M11 (relaxed). | High | Mixed |

### Cost / storage + saturation (IMPROVED)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 126 | Cron fleet busy-seconds up ~10× since 09-15 (Atlas sync family + jobid 303). | **Med–High** | Product/architecture decision (Trevor) |
| 75 | `net._http_response` ~13 GB store — **CLOSED 09-20**, gone; DB down to 19.8 GB. | ✅ closed | (done) |
| — | DB compute resized SMALL → LARGE (09-20) — M11's structural ceiling lifted. | ✅ landed | (done) |
| 56 | `wmc` index bloat regrows; no reindex job. | Med | Small (book a cadence) |
| 61 / 76 | Vercel build compute 75% (M10); 09-10 spend-cap pause resolved (budget raised). | Med | Re-measure at invoice |

### Data-intelligence correctness / honesty

| Item | Issue | Severity | Effort |
|---|---|---|---|
| 128 | 82,864 fabricated-zero pack rips drained; write-vs-read fabrication class swept clean; residual dilution draining, undisclosed on-surface. | **Medium–High** | Mostly landed; residuals open |
| 129 | Market-tab filters silently ignored on 4/5 collections; Pinnacle+Candy fixed, TS+AllDay need RPC params. | Medium | Migration (Trevor/CC) |
| 131 | Candy boards double-counted listings; view half fixed, ingest half open. | Medium | Small (ingest dedup) |
| 116 | Base-edition impossible serials (1,727 rows / 73 editions); trust metric blind to it; chain read owed. | Medium | Investigation (do NOT widen metric) |
| 67 / 70 | TS sales recovery; All Day M2 numerator, blocker relaxed by NFL season. | Medium | Landed / not a code fix |
| 50 / 33 / 39 | pack-reality ranker (counterfactual corrected 09-20); ISR failed-read window; underpriced-serials 503. | Medium (Trevor) | Small–Medium |

### Instruments / darkness / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 130 | `ingest-pinnacle-mints` 403 — secret owed. | **High (operator)** | One secret |
| 55 | Both 2-hourly Routines `enabled:false` since 09-01. | Med (operator) | Small (recreate on device) |
| 125 | Atlas `SearchMarketplaceTransactions` Cloudflare 403; new transport shipped, command owed. | Med (operator) | Small |
| 34 / 80 / 77 / 100 | Sentry dark (beacon is detector); GitHub schedule-event drop; fleet alarm single-channel; master alarm GHA trigger ~27–29%. | Med | Move alarms off GHA / multi-channel |
| 60 | Cannot revoke anon/authenticated from net/cron schemas; needs Supabase support. | Low–Med | External |

### Security

| # | Issue | Severity | Effort |
|---|---|---|---|
| 82 | ✅ Live trust breach CLEARED — impossible-parallel serials 0 (live 09-21), guarded writer verified. | ✅ resolved | (done) |
| 32 | ✅ Gate-key rotation COMPLETED 09-20. | ✅ closed | (done) |
| 83 | Decoder fixed; 9,486 rows still name the custodian (backfill owed). | Med (partial) | Medium |
| 22 | 🚨 Credential purge — branch deleted, blob still fetchable; rotate regardless. | **P0 (operator)** | GitHub GC + rotation |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 / 10 | Monolith page refactor — re-measured this run (shell restored) and all growing: DashboardClient **2,948**, CollectionAnalyticsClient **1,927**, SniperClient **1,849**, CollectionTabClient **1,494**, MarketClient **1,273** (now under `app/(collections)/[collection]/*`). | Low–Medium | Large |

### Mobile layout (NEW findings)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 132 | ~3,900 sub-44px tap targets (from 5,113); full-width board rows, a scroll-vs-reach product trade. | Low–Med (Trevor) | Product call |
| 133 | Two filter pills on set-squeeze / offer-spread hit-test to another element; pre-existing, undiagnosed. | Low–Med | Investigation |

### SEO / growth

| # | Issue | Severity | Effort |
|---|---|---|---|
| 66 | Zero external links; ~31K indexed pages rank on page N. | Med | Off-platform (not code) |

### Stalled / scaffolded + deferred hardening

- Cart / Trade Hub / Gifting — **DELETED, verified still absent.**
- Deferred hardening (intentional): `email_subscribers`/`outbound_clicks`/`portfolio_snapshots`/`support_conversations` public INSERT policies; `user_achievements`+`watchlist_items` still on `owner_key` (text); Golazos `highest_offer` gap SETTLED (no offer source exists — do NOT build the indexer); `INGEST_SECRET_TOKEN` still to be rotated (Trevor, ~15 functions).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query.
- **Supabase compute is now `LARGE` (resized from SMALL 2026-09-20).** ⚠ Any pre-09-20 finding citing the SMALL-tier disk-IO floor (e.g. the 22 MB/s figure) is stale — re-derive. The disk-IO ceiling that made M11 structural is materially higher now.
- **A function-level `SET statement_timeout` is INERT on pg_cron** (`#43`).
- **Eight caller sources** — including a Windows Scheduled Task on Trevor's box and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old list is replaced by **`docs/strategy/roadmap-2026-08-03.md`** (accuracy-is-the-gate) and **`docs/strategy/go-live-2026-09.md`** (the numbers + the series):

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM share must beat incumbents.** | **Top Shot MET on the 27-leg series (53.1% mean); All Day NOT MET (28.7%) but its blocker relaxed. Read as a series.** |
| Go-live | **M1–M11 bars.** | Met: M1, M3, M6, M7, M9. Below bar: M2, M4, M5, M8, M10, M11 (relaxed). |
| 1 | **Prove the product with real users — 50+ WAU.** | **Open — the critical path. WAU flat at 1 (live 09-21).** |
| 2 | Cost / latency / saturation levers. | **Improved — DB tier resized, storage −35%; residual is cron-fleet cost #126 (Trevor).** |
| 3 | Durable debt. | Heavy advance — #128 fabricated-zero drain + class sweep, #129/#131 filter/dedup fixes, gate-key rotation. |
| 4 | Chain two, readiness-gated. | Candy LIVE (thin); Panini decided (mint-capture 403'd, #130). |

**Standing guardrails:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight sources).

**Housekeeping still outstanding:** set the #130 Pinnacle-mints secret; action the #22 purge GC + credential rotation (and `INGEST_SECRET_TOKEN`); recreate the two disabled Routines on-device (#55); complete the #129 TS/AllDay RPC-param migration + #131 Candy ingest dedup + #123 worker deploy; make the cron-fleet #126 architecture call.

---

## 5. In-code TODO inventory

A first-hand `grep -rnE '\b(TODO|FIXME|HACK|XXX)\b'` over `app/ lib/ components/ scripts/ workers/` (`*.{ts,tsx,js,jsx,mjs,cjs}`; node_modules/.next/.git excluded) found **4 markers, none actionable** — unchanged in character from prior weeks. Full breakdown:

### 5a. Narrative / resolved-work references (4 matches)

- `app/api/rtr/lock-roi/route.ts:38` ("v2 folds in the two signals the v1 TODO called out"), `lib/rtr-lock-roi-weights.ts:7` ("resolves the standing … TODO"), `lib/chains/solana/normalize.ts:46` (describes a former TODO placeholder), `lib/format.ts:6` (the `"$X,XXX.XX"` format doc — the `XXX` here is a format-string literal, the exact false positive the task names). All describe resolved work or are literals.

### 5b. Candy launch-flag-gated "note" branches (2 refs) — keep by design

- `app/api/candy-sales-indexer/route.ts` and `app/api/ingest/candy-editions/route.ts` — `note: "…TODO_-prefixed placeholder"` strings inside launch-flag-gated defensive branches (constants filled, branches unreachable in practice; `TODO_` doesn't match `\bTODO\b`).

### 5c. Solana readiness-guard refs (6 refs) — guard functions, not open work

- `lib/chains/solana/normalize.ts` — the `startsWith("TODO_")` readiness-guard functions + their `TODO_3/4/5 RESOLVED` narrative. Placeholder-guards, not open TODOs.

### 5d. Panini draft/reference lines — draft-only, all closed

- `docs/drafts/panini/ingest-panini-runner.mjs` (`TODO(go-live) RESOLVED 2026-07-16/19`) and `docs/drafts/panini/panini-proxy/index.js:19` (`TODO(discovery) CLOSED 2026-07-19`) — annotated resolved/closed draft scaffolding.

> **Net change since last week:** none of consequence. Live application code has zero actionable TODO markers. Vendored `workers/**/node_modules/` markers are third-party and excluded by the glob.

---

## 6. Resolved / no action needed

Verified against `docs/reference/known-issues.md` STATUS INDEX and `docs/overnight/metrics-latest.json`:

**Carried, still resolved:** #0, #1/#3/#3b (Cart/Trade Hub/Gifting — deleted, verified absent), #4 (Pinnacle FMV), #5, #7, #9, #12, #15, #19, #23, #24, #27, #28, #30 (re-opened then), #31, #36, #37, #38, #40, #41, #44, #45, #46, #47, #53, #57, #59, #68, #69, #78, #86, #87, #89, #92, #95, #96, #97, #105, #106, #111, #112. ⚠ **#8 remains REGRESSED / measured-dead** — see §2.3/§9.

**Newly resolved / closed since last week:**
- **#32** cron-ops merge — CLOSED 09-20 (Trevor saved the merged rpc-cron-ops card; gate-key rotation completed).
- **#75** `net._http_response` ~13 GB — CLOSED 09-20 (subject gone; DB down ~10.8 GB).
- **#121** `rpc_ops_snapshot()` — CLOSED 09-20 (659 ms warm vs the 45 s it was blowing through; mechanism was the visibility map, not the compute tier).
- **#122** 09-18 outage (instance lost outbound DNS while Postgres kept writing) — RESOLVED 09-18.
- **#124** — CLOSED 09-19.
- **#126** cron busy-seconds — RESOLVED 09-20 as far as the filed lanes go (0/34 failed since the resize); the fleet-cost decision persists as a Trevor item.
- **#82** live trust breach — the metric reads 0 today under the guarded writer.

**Note on churn:** the register grew from 111 to 131 numbered items in one week (`#0–#113` → `#0–#133`); the closed count rose 46 → 50. Heavy audit/ship cadence, not a change in scope.

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the go-live bars:

1. **Set the #130 Pinnacle-mints secret (Trevor).** One `supabase secrets set`; mint capture is currently stopped and it is a one-command fix.
2. **Action the #22 purge residue (Trevor):** GitHub GC the unreachable objects and **rotate the credential regardless** — branch deletion does not un-expose the blob. Rotate `INGEST_SECRET_TOKEN` in the same pass.
3. **Recreate the two 2-hourly Routines on-device (#55)** with `requires_local_device`.
4. **Make the cron-fleet #126 architecture call.** The 09-20 resize bought headroom; the Atlas sync family + jobid 303 still dominate busy-seconds and want a product/architecture decision, not another autonomous tweak.
5. **Finish the correctness halves:** #129 (TS/AllDay Market-tab RPC-param migration), #131 (Candy listings ingest dedup), #128 (surface the in-progress dilution or accelerate the drain), #123 (worker `wrangler deploy`).
6. **Drive traffic against the 50+ WAU gate (§2.1).** The accuracy bars are close enough that demand is the binding item; pick one channel.
7. **Re-read M2 off the series after a full clean NFL week** (`rpc_trust_health_history`), and **re-count M11 spells over a clean week on the LARGE tier** to confirm the structural fix.
8. **Verify the cost mitigations at the next invoice** (Vercel build machine, M10).

---

## 8. Notes from verification

- **✅ Sandbox shell restored this run.** `git`/`grep`/`wc` all work; commit counts and line counts are first-hand. **731 commits** since 2026-09-14 (`git log --since`).
- **Counts measured this run:** CI = **19** jobs under `jobs:` in `.github/workflows/ci.yml` (changes, memory-docs, docs-tests, **inherited-status** [new], typecheck, eslint-ratchet, cadence-lint, cadence-escrow-tests, unit-tests-shard, unit-tests, component-tests, worker-tests, workers-typecheck, db-tests, ledger-guard, register-guard, inbox-guard, tree-corruption, edge-deno); DB-invariant test files = **196** (`supabase/tests/*.sql`, `ls`); `app/insights/*/page.tsx` = **30**. Monoliths re-measured (`wc -l`): DashboardClient 2,948 / CollectionAnalyticsClient 1,927 / SniperClient 1,849 / CollectionTabClient 1,494 / MarketClient 1,273.
- **Live DB reads 2026-09-21 (PT):** demand `SELECT` over `auth.users` / `user_profiles` / `saved_wallets` / `email_subscribers` → 28 / WAU 1 / MAU 8 / 135 / 27-of-28 / 0 subs; accuracy legs from `rpc_trust_health_precompute` (TS 55.3, AllDay 30.7, Pinnacle 27.6, impossible-parallel 0, board-slow 0); DB size `sum(pg_database_size)` → 19,759 MB.
- **Accuracy SERIES** is the 27-leg `rpc_trust_health_history` read of 2026-09-18 (M1 53.1% mean 23/27 ≥ 50; M2 28.7% mean 6/27 ≥ 30); today's single legs are labelled as legs, per the file's *read-the-series-not-the-leg* rule.
- **TODO scan: 0 actionable markers in live app code** (§5) — `grep -rnE '\b(TODO|FIXME|HACK|XXX)\b'`; the one `XXX` hit is a `$X,XXX.XX` format literal.
- **Deletions verified by absence (`ls`):** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` — all absent.
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`.
- **Cited paths spot-checked — all 28 resolve:** `docs/strategy/{roadmap-2026-08-03,go-live-2026-09}.md`, `docs/reference/{known-issues,roadmap-status,database,cron-and-schedulers,key-files-and-honesty,autonomous-tasks,testing-and-ci,packs}.md`, `docs/audits/deep-audit-register.md`, `docs/overnight/{ledger.md,metrics-latest.json,focus.md}`, `components/telemetry/ClientErrorBeacon.tsx`, `scripts/qa/mobile-sweep.mjs`, `lib/{launch-flags,collections,address,api-error}.ts`, `lib/insights/board-status.ts`, `lib/analytics/fetch-json.ts`, `lib/og/board-empty-copy.ts`, `app/api/{seed-wallet-refresh,market}/route.ts`, `.github/workflows/{ci.yml,migration-autorecover.yml}`, `e2e/mobile-layout.spec.ts`. **Absent (correctly):** the four deleted product dirs, `lib/blazers-trivia.ts`, `docs/FREEZE.md`. ⚠ **Stale-path note:** last week's report listed the monoliths under `components/*`; they live under `app/(collections)/[collection]/*` — corrected here.
- **Known-issues STATUS INDEX:** its own generated line reads **131 numbered items — 63 open · 18 partial · 50 closed**, running `#0–#133`, derived from each item's own first sentence.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-09-21)

The register's own generated STATUS INDEX reports **131 numbered items — 63 open · 18 partial · 50 closed**, running `#0–#133`. ⛔ `closed` means the item *says* it is closed — read its own date stamp. Items that MOVED this week (the full slate carries its prior verified status — see `PROJECT_HEALTH_2026-09-14.md` §9):

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 8 | sports-proxy 403 | 🟡 open | REGRESSED / measured-dead; suppressed to 2026-10-14 | known-issues #8 |
| 22 | 🚨 Credential purge | 🟡 open | Branch deleted; blob still fetchable; **GC + rotation owed to Trevor** | index + metrics queue |
| 32 | cron-ops merge / gate keys | ✅ closed | CLOSED 09-20 — card saved; gate-key rotation completed | known-issues #32 |
| 55 | 2-hourly Routines cloud-only | 🟡 open | **Both `enabled:false`, last fire 09-01** — recreate on-device | known-issues #55 |
| 75 | `net._http_response` ~13 GB | ✅ closed | CLOSED 09-20 — subject gone; DB −~10.8 GB to 19.8 GB | known-issues #75 |
| 82 | 🚨 mis-keyed parallel serials | 🟡 open | **Metric reads 0 live (09-21)** under the guarded writer (verified 09-14 12:06 PM PT) | live read |
| 116 | base-edition impossible serials | 🔴 open | NEW 09-14 — 1,727 rows / 73 editions; three hypotheses refuted; chain read owed; do NOT widen metric | known-issues #116 |
| 121 | `rpc_ops_snapshot()` slow | ✅ closed | CLOSED 09-20 — 659 ms warm; mechanism was the visibility map | known-issues #121 |
| 122 | 09-18 DNS/outage | ✅ closed | RESOLVED 09-18 12:0x PM PT | known-issues #122 |
| 125 | Atlas transport Cloudflare 403 | 🟡 open | Fix shipped 09-19; one operator command owed | known-issues #125 |
| 126 | cron fleet busy-seconds ~10× | ✅ closed | RESOLVED 09-20 for the filed lanes (0/34 failed post-resize); fleet-cost decision persists (Trevor) | metrics + known-issues #126 |
| 128 | 82,864 fabricated-zero pack rips | 🟠 partial | PARTLY RESOLVED 09-20 — both writers fixed, drained, class swept clean; dilution residual draining | known-issues #128 |
| 129 | Market-tab filters silently ignored | 🟠 partial | Pinnacle+Candy fixed 09-20; TS+AllDay need RPC params | known-issues #129 |
| 130 | 🚨 ingest-pinnacle-mints 403 | 🔴 open | NEW 09-20 — `?key=` fn deployed before its secret; one Trevor secret owed | known-issues #130 |
| 131 | Candy boards double-counted | 🟠 partial | View half fixed 09-20; ingest half open | known-issues #131 |
| 132 | ~3,900 sub-44px tap targets | 🟡 open | NEW 09-20 — product trade, do NOT drain autonomously | known-issues #132 |
| 133 | pills hit-test to another element | 🟡 open | NEW 09-20 — pre-existing, undiagnosed | known-issues #133 |

**Tally (per the register's own STATUS INDEX):** **131 numbered items — 63 open · 18 partial · 50 closed**, running `#0–#133`. Plus the go-live plan (M1–M11 / B1–B5, read as a series), the per-collection accuracy series, Candy live + Panini decided, **19-job CI**, **196 DB-invariant test files**, and **30 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** the week's story is the reversal of last week's operational alarms. The DB compute tier was resized **SMALL → LARGE**, storage fell **35% to 19.8 GB** (#75's 13 GB store gone), the **live trust breach cleared** (0 today), the **NO-PUSH lifted** (731 commits, autonomous pass shipping), and the **gate-key rotation completed**. Against that, the audit cadence surfaced real correctness work — **#128's 82,864 fabricated-zero pack rips** (one dist publishing five cents for an eighty-dollar pack, now drained and the class swept clean), **#129's silently-ignored Market-tab filters**, **#131's double-counted Candy boards**, and **#130's stopped Pinnacle mint capture** waiting on one Trevor secret. On the front page, **Top Shot is MET on the 27-leg accuracy series and All Day's blocker relaxed** (NFL-season volume) but M2 is still NOT MET on the series, and **WAU is flat at 1 against a 50+ gate**. **Demand is still the one number that decides everything.**
