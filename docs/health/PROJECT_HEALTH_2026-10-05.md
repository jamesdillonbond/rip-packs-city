# Rip Packs City — Project Health Report

**Date:** 2026-10-05
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (generated STATUS INDEX, now reading **172 numbered items — 5 open · 35 partial · 132 closed**, newest slots filed this week reaching **#174**), `docs/reference/roadmap-status.md` (accuracy-is-the-gate framing + the 2026-10-03 FMV out-of-sample backtest block), `docs/strategy/{roadmap-2026-08-03,go-live-2026-09}.md`, `docs/overnight/ledger.md` (newest heading 2026-10-04), the sibling project docs `weekly-health-digest-2026-10-05` and `handoff-2026-10-05-overnight-pass` (both captured this morning, ~07:38Z / ~08:11Z = ~12:38–1:11 AM PT), plus first-hand file-tool + shell scans (`git`, `grep`, `wc`) and **live DB reads (2026-10-05, before ~3:28 AM PT — corrected at commit time from "afternoon PT"; the file was written 3:28 AM PT)** for demand, accuracy, DB size and the #128 drain.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#174`), the go-live framing, the prioritized actions, the overnight operational queue, and the in-code marker inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-09-28.md` (7 days ago). This regeneration mirrors its structure. `_2026-09-21.md` … `_2026-05-22.md` (twenty-three prior reports) also live in `docs/health/`.

> **Biggest change since 2026-09-28 — a heavy data-correctness + chain-truth week, not a register-reconciliation week.** Last week collapsed the open backlog from 63 → 2; this week the register **grew from 153 → 172 items** (open **2 → 5**, partial **34 → 35**, closed **117 → 132**) as a deep run of Flowty/Dapper chain-truth work and Top Shot identity fixes landed. The single biggest ship is the **Flowty re-promotion: +143,575 chain-verified sales named from sale-block reads** (`flowty_chain_v1` / `flowty_chain_tx_v1` / `dapper_chain_tx_v1`, 10-04), which closed out most of the previously-unnamed secondary-market sales. Alongside it: **Top Shot team-Moment naming** (590 team Moments now `<team> — <set>` and `player_name = team_name`, 10-04), **player-twin merges**, **Panini NO_DATA retirement** (a delisted ask no longer serves its price forever), and the **sell-back exclusion** work (#169 — a `sales_market` view that drops Dapper instant buy-backs from every FMV writer, shipped 10-04). **#128 — last week's fabricated-zero pack-rip drain — is now fully drained** (Top Shot `pull_value_usd = 0` is **0**, live read today; was ~26,734 at the last report). Autonomous side was quiet: **five nightly passes (09-27, 09-28, 09-30, 10-03, 10-04) all GREEN — 0 shipped, 0 reverted.** The week's migrations and commits were concurrent Claude Code interactive/daytime sessions, not the nightly pass.

> **Overnight reality — GREEN and honest.** The 2026-10-05 ~01:08 AM PT Cowork pass (push-capable, lock taken/released, no `FREEZE`) shipped **0**, reverted **0**. Security all `[]` (invariants, anon-write holes, rls-off-base, secdef-anon); trust health **0 breaches, all 38 arms ok**; zero-yield offenders `[]`; sentinel `ts_uuid_editions_48h` 0; stalled pipelines `[]`; client-error beacon 3/24h (healthy). Vercel 24h errors were all **chronic/known groups + a now-cleared Panini board cluster** (after the 10-04 covering indexes) — no new group. The weekly digest reports **pipelines 99.7% success/24h** (149 errors of 44,508 runs), every failure leader known/by-design.

> **Traction reality — WAU up sharply to 12, but read it with a large asterisk.** Live reads (2026-10-05): **37 total accounts (+7), WAU 12 (+10), MAU 18 (+10), 165 saved wallets (+30)**, 33 of 37 users have a saved wallet, **1 email subscriber**. The digest corroborates "active users 12/7d". ⚠ **This number is not clean external demand:** it counts all `auth.users` sign-ins (internal/QA accounts are not excluded here, against CLAUDE.md's traction rule) and this week saw heavy **rewards dial-in testing** (the rewards economy — now switched on but *paused*, `REWARDS_LIVE` unset — logged 12 active users, all `scout_wallet` test earns). So WAU 12 overstates genuine outside users; treat it as "still single-to-low-double digits, still noise against the **50+ WAU gate**." The off-platform signal the digest watches: **outbound_clicks 11/7d** (non-zero), concierge 62/7d, portfolio_snapshots 224/7d. **WAU is still the one number that decides everything.**

> **Accuracy gate — Top Shot MET, All Day still short, and a NEW price-accuracy instrument this week.** Live `rpc_trust_health_precompute` legs (2026-10-05): **Top Shot 57.3%** HIGH/MED share (≥ 50% bar — MET on today's leg), **All Day 27.8%** (≥ 30% bar — NOT MET), Pinnacle **31.6%** (up from 30.6), Candy **23.2%** (up from 19.2), Golazos **1.0%**, UFC **0.0%** (empty-market sentinel). ⚠ These are **single legs**, not the 65-leg series the file tells you to read; the series was not recomputed this run. **New this week:** the FMV engine was measured **out of sample against the market for the first time** (`topshot_fmv_backtest` / `fmv_sales_backtest`, register R125). 7-day backtest (from the overnight pass): **Top Shot published median_ratio 1.000, median_abs_err 13.0%, within-25% 71.8%** (HIGH: 9.1% err, within-25% **87.3%**) — tracking the market; **All Day published ratio 1.20, err 26.7%** but **median_abs_err_usd $0.05** — its known sub-dollar market (93% of sales < $1), so a few-cent miss is a large %. Not a lagging estimator; a structural penny-market characteristic. Pricing routes are off-limits to the autonomous pass regardless.

> **Cost / storage — grown materially, mostly on purpose.** DB read **~31.8 GB live at the run (before ~3:28 AM PT)**; **34.4 GB this morning** (digest) — an **8× deviation from the stale 4.2 GB June baseline doc** (digest flagged the doc as needing an update). The growth is accumulation, not a runaway: genuine public data ~26 GB (four months' ingestion + this summer's Flowty/sales re-promotions, incl. this week's **+143k chain-verified sales**), a reappeared **`flowty_archive` staging schema at 4.2 GB** (the Flowty index + chain-truth staging, kept on purpose; a small `scratch_20261004_*` set ~0.1–0.19 GB has a written drop script awaiting a SQL-editor run), pg_toast ~3.5 GB, and the chronic **`net._http_response` pg_net log ~3.5 GB** (TTL-managed). Compute stays **LARGE** (resized 2026-09-20); pipelines 99.7% success/24h, no saturation spell.

> **Platform context (largely unchanged).** Top Shot's public REST API stays dead; the Atlas backend read is the feed, still answering a Cloudflare JS challenge (403) on some lanes (designed-for, self-healing). Flowty's trading frontend is shut and **Trevor flagged 2026-09-25 that Flowty will turn its API endpoints off "soon"** — the teardown is pre-staged and RPC is now Flowty-independent for priced columns (re-verified 2026-10-03: 0 current HIGH/MEDIUM/ASK_ONLY editions carry a Flowty-derived ask; All Day + Golazos asks now come from Dapper's own storefronts). NFL All Day secondary-market only. UFC Strike Flow market frozen (0 sales; honestly labelled). Candy/Solana LIVE, thin. Panini = WC Prizm plane (`PANINI_PUBLIC = true`).

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/strategy/{roadmap-2026-08-03,go-live-2026-09}.md` for the plan. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Report location stays clean.** All twenty-four reports (this one included) live in `docs/health/`; the repo root holds none (verified this run).

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#174** | Register STATUS INDEX: **172 numbered items — 5 open · 35 partial · 132 closed**. ~19 new slots (#155–#174) since last week. See §9. |
| Known issues — resolved/closed since last week | **~15 net** | Closed count rose 117 → 132. Biggest: Flowty re-promotion (+143,575 sales), Top Shot team-moment naming, Panini NO_DATA retirement, player-twin merges, #128 fully drained. — §6 / §9 |
| Known issues — open / partial | **40** | **5 open** (#22, #167, #169, #172, #173) + **35 partial**. Last week's #147 (duration-wrap) is no longer on the open list. — §3 / §9 |
| Known issues — 🚨 live trust breach | **0** | `topshot_impossible_parallel_serials` **0** (live 2026-10-05); `trust_health` 38/38 ok; `public_board_empty_count` 0; `fmv_sanity_flags` 0. — §2.4 |
| Known issues — needs Trevor, operator | **few** | **#22** purge GC + rotation (P0, unchanged); **#144** rotate `ATLAS_POOL_INGEST_KEY`; the `flowty_archive` scratch-drop + tx-lane dedupe (SQL editor); **#172** giveaway desktop delivery; **#23/#24** edge-fn + pin drift. — §2.6 |
| Known issues — carried shelved | **1** | **#8 sports-proxy 403** — SHELVED (Trevor delegation); alarm muted to 2026-10-28; `sync-nba-projections` 24/24 failing by design, fails safe. — §2.3 |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent this run. |
| Go-live plan | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md`. Accuracy gate: Top Shot MET on its leg, All Day short. — §2.1 |
| Commits since last report | **1,240** | `git log --since 2026-09-28`. Authors: Claude 924, Trevor 255, Cowork cloud 38, Cowork 16, autorecover/nightly bots ~7. Tip `49e8c6178` 2026-10-05 00:43 PT (Trevor). |
| Accuracy gate (headline metric) | **Per-collection, live legs** | Top Shot **57.3%** (MET), All Day **27.8%** (NOT MET), Pinnacle 31.6, Candy 23.2, Golazos 1.0, UFC 0.0 (sentinel). Legs, not the 65-leg series. NEW: price backtest — TS ratio 1.000 / 13.0% err; All Day 1.20 but $0.05 median abs err (penny market). — §2.1/§2.3 |
| Demand (the critical-path number) | **WAU 12 · 37 accounts · 165 saved wallets** | Live 2026-10-05. ⚠ Includes internal/QA + rewards dial-in testing — overstates external demand. MAU 18. Gate: **50+ WAU**. — §2.1 |
| Open overnight operational items | **standing queue** | #22 purge residue; #144 key rotation; `flowty_archive` scratch-drop + tx-lane dedupe (SQL editor); #23/#24 drift; #172 giveaway desktop delivery. — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana LIVE thin + Panini (WC Prizm, collector-walk live); plus a paused Rewards economy (dial-in). — §2.8 |
| Prioritized next actions | **superseded** | `roadmap-2026-08-03.md` (accuracy-is-the-gate) + `go-live-2026-09.md`. Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **0 actionable in live app code** | Measured this run (`grep`): 4 narrative/false-positive refs only (incl. the `$X,XXX.XX` literal). — §5 |
| Test / DB-invariant pins | **252 `supabase/tests/*.sql` files** | +31 vs last week's 221 (measured this run, `ls`). |
| CI jobs (ci.yml) | **20** | Measured this run under `jobs:`: −1 vs last week (`cadence-lint` dropped). See §8. |
| Public `/insights` surfaces | **31** | Measured this run: 31 `app/insights/*/page.tsx` dirs (+1). |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU. |

**Health read:** A heavy correctness/chain-truth week. The register **grew** (153 → 172) because real discovery landed, not because scope ballooned — most of the new slots are new-and-closed. The headline wins: **Flowty re-promotion named +143,575 chain-verified sales**, **#128's fabricated zeros fully drained to 0**, Top Shot team Moments are now named and attributable one way, and Dapper instant sell-backs stopped polluting FMV (#169's `sales_market` view). On accuracy, **Top Shot is MET (57.3% leg) and the new out-of-sample price backtest shows it tracking the market (ratio 1.000)**; **All Day is still short of its 30% bar (27.8%)** and its backtest %-error is a penny-market artifact, not a lagging estimator. The concentrated risk that remains: **(1) demand** — WAU is noisy and testing-inflated, still far under 50+; **(2) five open items**, of which #22 (credential-purge residue, P0 operator) is weeks old and unchanged; **(3) two Top Shot edition-conflation items** (#171 partial, #173 open) where a parallel's/wrong-set's price can still feed the wrong edition's FMV until `topshot_moment_subeditions` coverage catches up; **(4) operator hand-offs** — #144 key rotation, the `flowty_archive` scratch-drop + dedupe SQL (SQL editor only), #172 giveaway desktop delivery.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public + self-serve. **WAU 12 (testing-inflated) / 37 accounts / 165 saved wallets (live 10-05).** Accuracy at/around its bars. The problem is still *demand*. Gate: **50+ WAU** (§2.1) |
| **Chain-truth / sales completeness (the week's big workstream)** | Flowty re-promotion +143,575 sales; sell-back capture gap (#167); sell-backs-as-market-sales excluded (#169); All Day buyback promotion (#160/#161) (§2.3) |
| Top Shot edition identity / conflation | Team-Moment naming (590, 10-04); parallel re-key (#171, 29,814 sales); base-edition conflation (#173, ≈1–1.5k rows) (§2.3) |
| **Live trust breach still CLEAR** | `topshot_impossible_parallel_serials` 0 (live 10-05); `trust_health` 38/38; boards empty 0 / slow 1 (known `panini_sale_feed_status`, by decision) (§2.4) |
| Player / entity identity | player-twin merges; team-as-subject resolution; name pairs vs NBA.com/NFL.com (carried) (§2.3) |
| Chain foundation | Candy LIVE thin; Panini WC Prizm plane, collector-walk live; Rewards economy paused/dial-in (§2.8) |
| Operator-owned / hand-offs | #22 purge (P0); #144 `ATLAS_POOL_INGEST_KEY`; `flowty_archive` scratch-drop + tx-lane dedupe (SQL editor); #172 giveaway desktop delivery; #23/#24 edge-fn + pin drift (§2.6) |
| Instrument darkness | #34 Sentry dark (beacon is the detector); #80 GitHub schedule-event drop; #77/#100 alarm channel/trigger (§2.5) |
| Security | scans clean; trust breach clear; #60 (can't revoke anon from net/cron schemas) carried, needs Supabase support (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent (§2.9) |
| SEO | #66 — zero external links, ~56K indexed pages rank on page N; off-platform, not code (§2.3) |
| Tech debt / refactor | Monoliths re-measured this run and all still growing: DashboardClient **2,981** / SniperClient **2,081** / CollectionAnalyticsClient **2,022** / CollectionTabClient **1,596** / MarketClient **1,426** (§3) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled: no offer source); `INGEST_SECRET_TOKEN` rotation still owed; `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller) |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is two layers: **`docs/strategy/roadmap-2026-08-03.md`** (accuracy is the GATE — headline metric is the HIGH/MEDIUM confidence share) and **`docs/strategy/go-live-2026-09.md`** (what "through the gate" means in numbers). The only user gate remains **50+ WAU**.

### 2.1 Launch + activation — Top Shot MET, All Day short, demand noisy — `Severity: High · Effort: Medium (built + measured, needs clean traffic)`

Read-only tabs are anonymous for the 5 published Flow collections (+Candy overview, +Panini); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction, live read 2026-10-05:** **37 total accounts, WAU 12, MAU 18, 165 saved wallets**, 33 of 37 with a saved wallet, 1 email subscriber. ⚠ **WAU 12 is inflated by internal/QA accounts (not excluded in this raw read) and by this week's rewards dial-in testing** (12 active `scout_wallet` test earners). Genuine external demand is still low. The first faint off-platform signal is **outbound_clicks 11/7d**.
- **Accuracy (live precompute legs, 2026-10-05):** **M1 Top Shot 57.3% (≥ 50% — MET on the leg)**, **M2 All Day 27.8% (≥ 30% — NOT MET)**, Pinnacle 31.6, Candy 23.2, Golazos 1.0, UFC 0.0 (sentinel). These are single legs; the 65-leg series (`rpc_trust_health_history`) was not recomputed this run — read it as a series before acting.
- **NEW — price accuracy, out of sample (7d, `fmv_sales_backtest`):** Top Shot published **median_ratio 1.000, median abs err 13.0%, within-25% 71.8%** (HIGH 9.1% err, within-25% 87.3%) — the published price tracks what collectors actually paid. All Day published **ratio 1.20, err 26.7%** but **median abs err $0.05** on a market where 93% of sales are < $1 — the %-error is a penny-market artifact. See also #167/#169 below (sell-back handling, which this backtest excludes by design).
- **M2 did not convert again.** All Day's HIGH/MED share has been flat-to-down for several weeks; it stays liquidity-limited and the code-side levers are small.

Suggested next step unchanged: **pick one acquisition channel and run it against the 50+ WAU gate** — and separately, get a clean WAU read by excluding `internal_accounts` and the rewards test cohort so the number means external demand. Still the single most important item in the report.

### 2.2 Public intelligence surfaces — 31 public — `Severity: n/a (shipped) · context`

All 31 built surface dirs in `app/insights/` are public (measured this run: 31 `page.tsx`, +1). New this week: the **Pack Sniper "Simulate" CTA + `/api/pack-simulator` were opened to anonymous GET/HEAD** (10-04) after a link crawl found the simulator page gated behind `/login` on every pack-sniper row. Carried honesty risks `#50` (`/insights/pack-reality` ranker) and `#33` (ISR bakes a failed read into the `revalidate` window) remain. The one slow public board (`public_board_slow_count = 1`, live) is `panini_sale_feed_status`, a 1.8M-row census left as-is by decision (R50, 10-04) — a precompute would cost more IO than the ~4 real reads/day it serves.

### 2.3 Data-intelligence — chain-truth re-promotion, sell-back handling, Top Shot conflation — `Severity: Medium (correctness) · Effort: mixed`

**FMV HIGH/MEDIUM share (live legs, 2026-10-05):** Top Shot 57.3, All Day 27.8, Pinnacle 31.6, Candy 23.2, Golazos 1.0, UFC 0.0 (empty-market SENTINEL, never a percentage).

**Shipped / found since last week:**

- **Flowty re-promotion — +143,575 chain-verified sales (10-04).** Sale-block reads named the previously-unnamed Flowty/Dapper secondary sales from the chain: walk lane `flowty_chain_v1` +88,218, tx lane `flowty_chain_tx_v1` +52,348, Dapper `dapper_chain_tx_v1` +3,009. Integrity pass clean (0 null edition, 0 non-positive price, DUC/USDC only). A 7-row walk/tx duplicate was found and is queued for a dedupe in the SQL editor (see §2.6). Scratch drivers all stopped.
- **`#128` — the 82,864 fabricated-zero pack-rip drain is COMPLETE.** Live read today: Top Shot `pull_value_usd = 0` is **0** (was ~26,734 at the last report; positive rows 283,506). The `null_pull` rows (612,020) are the honest "no pulls computed" state, not fabricated zeros. Effectively resolved.
- **`#169` — sell-backs counted as market sales — FIX SHIPPED 10-04.** FMV/price readers were counting Dapper's instant buy-backs (buyer `0xe1f2…`, in the `buyback_wallets` registry) as market sales. A new `public.sales_market` view = `sales` minus buy-backs per collection, and **12 FMV writers + the 2 Top Shot FMV routes were repointed to it** (server-side rewrite, md5-checked against the committed file; a tree-walk guard stops a new reader forgetting it). The selectors and display reads stay on raw `sales` on purpose. **Exit remaining:** re-measure the confidence mix on the 64 sell-back-only editions after the re-price, then resume #167's lanes. Index still marks it open until that exit lands.
- **`#167` — Top Shot instant sell-backs are missing from `sales` (OPEN).** The mirror of #169: a custodial pack a collector sold straight back to Dapper is largely invisible unless one of its moments happened to land in `sales` (88 of 228 moments in a biased-upward sample). Impact: wallet pack counts undercount heavy sell-back openers; FMV likely unaffected (fixed $1 sell-backs aren't market prices). **Exit:** measure the estate-wide capture rate on a sample window, then either ingest sell-back purchases (a new MomentPurchased lane) or decide they stay out and say so.
- **`#171` — parallel Top Shot moments filed under their BASE edition (PARTLY RESOLVED 10-04).** 29,814 sales re-keyed onto their parallel edition and 69,487 `topshot_moment_subeditions` rows filled from the chain (migration `20261004153801`), after the live chain agreed with the checkpoint on 1,000/1,000 random NFTs. ⚠ Still open: parallels the checkpoint never read still fold until the table's coverage catches up.
- **`#173` — `topshot_moment_subeditions` holds the WRONG base edition for a slice of NFTs (OPEN).** A conflation (same player, different set): 629+153+26 chain-verified sales stayed out as `edition_conflict`. Size ≈ 0.2% of a 2% sample → ≈1–1.5k rows table-wide (unmeasured exactly). The held-back sales were inserted with the checkpoint edition (mitigated), but **the table itself is not corrected** — many readers/writers, so a fix must find the writer, correct `base_external_id` only where the spork roots agree, and re-key what those rows wrote. Same lineage as #171.
- **Top Shot team-Moment naming (10-04).** 590 team Moments (no player) are now named `<team> — <set>` ("Atlanta Hawks — Clamps"; a set page used to list 66 Moments all called "Clamps") and all carry `player_name = team_name`, so the team-page link and wallet-name fallback treat them one way. Both on-sale writers use `teamMomentSubject()` so a sale can't put the bare set name back.
- **Panini NO_DATA retirement (10-04).** A walked card whose only ask was delisted now writes `NO_DATA` / NULL FMV instead of serving the stale ask forever (41 editions, $396k of FMV, oldest 241h). A $500k ask-only Dembélé /12 and a 27%-of-Panini-FMV ask-only concentration were **filed as decisions** (no engine change).

**Carried / open:**

- **`#8` — sports-proxy 403 — SHELVED** (Trevor delegation, "no paid projections provider pre-revenue"). `sync-nba-projections` 24/24 failing by design, fails safe; alarm muted to 2026-10-28. Do NOT retire.
- **`#66` — SEO:** zero external links; ~56,555 sitemap URLs (33,423 on 08-27) rank on page N. Off-platform authority, not code.
- **`#116` — base-edition impossible serials (partial):** 1,727 rows / 73 editions carry a serial their edition cannot contain; trust metric is parallel-scoped so reads 0. Do NOT widen the metric; the chain read is owed.
- **`#94` — Top Shot pack-supply source (partial):** the source question is answered (Atlas `DistributionService`); a new lane walks all 5,326 drops into `topshot_atlas_dists`. Left: re-point the pack page's depletion from the frozen `topshot_pack_supply` to the new tables, then retire the HTTP-530 probe (jobid 15) — needs a semantics decision first.
- **`#160` — All Day price recovery (partial):** (a)/(d) closed (budget-exhausted backlog 0; a zero-candidates-with-backlog alarm now exists). (b) still waiting on an edition for segment-priced rows; the buyback-promotion widening shipped 10-01 after Trevor's #161 decision.

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (clean scans; 0 live breaches) · Effort: mostly landed`

- **Security scans clean** (invariants, anon-write holes, rls-off-base-tables, secdef-anon all `[]`; digest: 0 public base tables with RLS off, 0 anon write holes).
- **Live trust breach clear.** `topshot_impossible_parallel_serials` **0** (live 2026-10-05); `trust_health` 38/38 ok; `public_board_empty_count` 0; `public_board_slow_count` 1 (the known `panini_sale_feed_status` census, by decision); `fmv_sanity_flags` 0.
- **`#22` — the credential-purge residue is STILL OPEN (P0, operator-only).** The leak branch was deleted from origin, but the pre-purge blob stays fetchable **by SHA** until GitHub Support GCs the unreachable objects, and the RS256 token PII does not expire. **Ask GitHub Support to GC, and rotate the Dapper session regardless.** `INGEST_SECRET_TOKEN` rotation (~15 functions) also still owed. Unchanged for weeks.
- **Last week's `#147`** (seven SQL functions computing `elapsed_ms` with `EXTRACT(MILLISECOND …)`, which wraps ≥ 60s) is **no longer on the open list** — it was expected to be fixed on the next touch of one of those functions and has dropped off; no live value was ever wrong (all runs finished under 60s).
- **`#60` (carried):** Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas; real fix needs Supabase support.
- **DB-invariant SQL layer: 252 `supabase/tests/*.sql` files** (+31, measured this run). CI is **20 jobs** in `ci.yml`. **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

⚠ **`#34` — Sentry dark since 2026-08-18; no-spend DECIDED** — the `window.onerror`/rejection beacon → `usage_events.client_error` is the detector (3 events/24h this week, healthy). ⚠ **`#80`** — GitHub schedule-event drop (partly mitigated). ⚠ **`#77`/`#100`** — the fleet alarm's channel and the master alarm's GHA trigger reliability (decided: move alarms off GHA / multi-channel). ⭐ **`#23`/`#24`** — 25 edge functions not on `main` and 6 of 187 DB pins stale; these are loudly-correct standing detectors, reconcile when convenient (digest queued item). ⭐ **`#62`** — the true-mobile QA instrument (`scripts/qa/mobile-sweep.mjs`, real Chromium at 390/320 px) remains the only real mobile instrument; the 10-04 surface QA ran 21 surfaces × desktop + 390px all clean.

### 2.6 Overnight operational queue — `Severity: Low–High (mixed) · Effort: mixed`

Health scans GREEN (0 new stalled pipelines). Open items for Trevor / operator:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **#22 — credential-purge residue** | Branch deleted; blob still fetchable by SHA; RS256 PII does not expire. | **P0 (operator)** | GitHub Support GC + rotate the Dapper session regardless; `INGEST_SECRET_TOKEN` too. |
| **`flowty_archive` scratch-drop + tx-lane dedupe** | `dedupe_tx_lane_20261004.sql` (7 tx-lane dupes) then `drop_scratch_20261004.sql` / `scripts/flow-wallet-walk/drop_scratch.sql`. Destructive SQL; MCP write-hold cancels it unseen from a headless session. | **Med (SQL editor)** | Run in the Supabase SQL editor, dedupe first. Pre-checks verified live (7 dupes; 0 cron jobs reference scratch). Reclaims ~0.19 GB. |
| **#144 — rotate `ATLAS_POOL_INGEST_KEY`** | `?key=` branch deleted + deployed (header-only, pinned); the key was in logs. | Med (operator) | Rotate the edge secret + Trevor's user env var. |
| **#172 — giveaway "Deliver all" stalls on desktop** | Flow Wallet browser extension sits at "waiting for your wallet…"; the iPhone (WalletConnect) path works. | Med (operator) | Make `0x3d0b…` the active account in the extension, hard-reload, retry on a fresh small drop; act on the 20s hint line. Workaround: deliver from phone. |
| **#23 / #24 — edge-fn + pin drift** | 25 edge functions not on `main`; 6 of 187 DB pins stale. | Low (standing) | Reconcile or re-date; loudly-correct detectors. |
| **#8 sports-proxy 403** | SHELVED; alarm muted to 2026-10-28. | Med (deferred) | Do NOT retire. |
| **#173 / #167 — Top Shot edition conflation + sell-back capture** | Pricing-adjacent, many readers. | Med (investigate) | Claude Code / Trevor to ship; see §2.3. |

### 2.7 Pack EV / pack-viz — `Severity: Low–Medium (correctness, mostly clean) · Effort: mostly landed`

Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. **#128's fabricated-zero drain is complete** (§2.3). The digest reports pack-EV freshness in range (AllDay 3,137 packs, 307 stale-3d; Top Shot 1,210 packs, 1,059 stale-3d but the board writes fresh daily — most stale rows are depleted/inactive packs) and board-level publish shortfall 0.79% (ok).

### 2.8 Chain foundation — Candy LIVE, Panini walked, Rewards paused — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — LIVE, THIN:** `CANDY_MLB_PUBLIC = true` (verified this run), overview tab.
- **Panini — the WC Prizm plane** (`PANINI_PUBLIC = true`, verified this run). FMV engine at `panini-1.2.0`; the collector-walk runs on Trevor's box; NO_DATA retirement shipped 10-04. ~560 inbox filings are an intended append-only steady state, not a backlog.
- **Rewards economy — exists but PAUSED (dial-in).** `REWARDS_LIVE` unset; award/redeem refuse. 25 participants, 14,200 issued / 250 spent, 1 fulfilled, 0 pending; this week's 91 ledger rows are `scout_wallet` test earns. 9 wallets verified total. Not warm enough to draft a Flow grant / Dapper pitch off these numbers.
- **Chain-abstraction Phases A–F complete.**

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** — verified this run by absence: `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` all absent. The product is purely read-only. (A `/admin/swap-test` harness exists for an internal two-signature Flow experiment; its `swap_test_relay` table is intentionally empty and user trading/escrow/matching stays off the table by steer.)

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/moved status.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** **WAU 12 / 37 accounts / 165 saved wallets (live 10-05)** — testing-inflated. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| — | **Go-live bars.** Accuracy gate: Top Shot MET (leg), All Day short. | High | Mixed |

### Security / operator (the open items + P0)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 22 | 🚨 Credential purge — branch deleted, blob still fetchable by SHA; RS256 PII persists. Rotate regardless. | **P0 (operator)** | GitHub GC + rotation |

### Chain-truth / sales completeness + Top Shot identity

| # | Issue | Severity | Effort |
|---|---|---|---|
| 167 | Top Shot instant sell-backs missing from `sales`; capture rate unmeasured. | Medium | Investigation + possible new lane |
| 169 | Sell-backs counted as market sales — `sales_market` view shipped; exit (re-measure the 64) pending. | Medium | Mostly landed |
| 171 | Parallel moments filed under base edition — 29,814 sales re-keyed; coverage gap remains. | Medium | Partly landed |
| 173 | `topshot_moment_subeditions` wrong base edition (≈1–1.5k rows); table not yet corrected. | Medium | Investigation (writer + re-key) |
| 160 | All Day price recovery — alarm + buyback promotion landed; (b) edition wait remains. | Low–Med | Partly landed |
| 94 | Top Shot pack-supply source answered; re-point pack page + retire 530 probe. | Low–Med | Decision + re-point |
| 116 | Base-edition impossible serials (1,727 / 73); trust metric blind; chain read owed. | Medium | Investigation (do NOT widen metric) |
| 66 | Zero external links; ~56K indexed pages rank on page N. | Med | Off-platform (not code) |

### Instruments / darkness / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 172 | Giveaway "Deliver all" stalls on desktop (Flow Wallet extension); phone works. | Med (operator) | Active-account + hard-reload retry |
| 144 | Rotate `ATLAS_POOL_INGEST_KEY` (was in logs); `?key=` branch deleted + deployed. | Med (operator) | One rotation |
| 23 / 24 | 25 edge fns not on `main`; 6/187 DB pins stale. | Low | Reconcile / re-date |
| 34 / 80 / 77 / 100 | Sentry dark (beacon is detector); GitHub schedule-event drop; fleet alarm channel; master alarm GHA trigger. | Med | Move alarms off GHA / multi-channel |
| 60 | Cannot revoke anon/authenticated from net/cron schemas; needs Supabase support. | Low–Med | External |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 / 10 | Monolith page refactor — re-measured this run and all growing: DashboardClient **2,981**, SniperClient **2,081**, CollectionAnalyticsClient **2,022**, CollectionTabClient **1,596**, MarketClient **1,426**. | Low–Medium | Large |

### Stalled / scaffolded + deferred hardening

- Cart / Trade Hub / Gifting — **DELETED, verified still absent.**
- Deferred hardening (intentional): `email_subscribers`/`outbound_clicks`/`portfolio_snapshots`/`support_conversations` public INSERT policies; `user_achievements`+`watchlist_items` still on `owner_key` (text); Golazos `highest_offer` gap SETTLED (no offer source — do NOT build the indexer); `sales-serial-backfill` substring-token check (latent dead code; `INGEST_SECRET_TOKEN` rotation owed); `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller — exit when the pool lane revives, #65).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query.
- **Supabase compute is `LARGE`** (resized from SMALL 2026-09-20). Any pre-09-20 finding citing the SMALL-tier disk-IO floor (e.g. 22 MB/s) is stale — re-derive.
- **The June 4.2 GB DB-size baseline doc is stale** — the DB cycles 22–34 GB now; the digest flagged the doc for update.
- **Flowty's API is expected to go dark "soon"** (Trevor, 09-25). RPC is now Flowty-independent for priced columns; the teardown checklist (three `*-listing-cache` sweeps + schedulers, `flowty-proxy`, v1 display readers) is pre-staged.
- **Disney Pinnacle grain:** a pin = a `pinnacle_catalog` row (`render_id`); readers AND writers must use the catalog.
- **A function-level `SET statement_timeout` is INERT on pg_cron** (`#43`).
- **Eight caller sources** — including a Windows Scheduled Task on Trevor's box and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old list is replaced by **`docs/strategy/roadmap-2026-08-03.md`** (accuracy-is-the-gate) and **`docs/strategy/go-live-2026-09.md`**:

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM share must beat incumbents.** | **Top Shot MET (57.3% leg) and now tracking the market out-of-sample (ratio 1.000); All Day NOT MET (27.8%) and flat. Read as a series.** |
| Go-live | **M1–M11 bars.** | Accuracy gate met for Top Shot, short for All Day; demand is the binding bar. |
| 1 | **Prove the product with real users — 50+ WAU.** | **Open — the critical path. WAU 12 live but testing-inflated.** |
| 2 | Cost / latency / saturation levers. | **Stable — DB 32–34 GB (genuine growth + TOAST + Flowty staging), tier LARGE, 99.7% pipeline success; update the stale size baseline doc.** |
| 3 | Durable debt. | Heavy advance — Flowty re-promotion (+143k sales), #128 fully drained, sell-back exclusion, team-moment naming, parallel re-key. |
| 4 | Chain two, readiness-gated. | Candy LIVE (thin); Panini walked; Rewards economy paused/dial-in. |

**Standing guardrails:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight sources).

**Housekeeping still outstanding:** action the #22 purge GC + credential rotation (and `INGEST_SECRET_TOKEN`); run the `flowty_archive` tx-lane dedupe then scratch-drop in the SQL editor; rotate `ATLAS_POOL_INGEST_KEY` (#144); retry the giveaway desktop delivery (#172); finish #169's exit (re-measure the 64, resume #167); investigate #173's `topshot_moment_subeditions` conflation; re-point the Top Shot pack-supply page (#94); get a clean WAU read (exclude internal + rewards test cohort).

---

## 5. In-code TODO inventory

A first-hand `grep -rnE '\b(TODO|FIXME|HACK|XXX)\b'` over `app/ lib/ components/ scripts/ workers/` (`*.{ts,tsx,js,jsx,mjs,cjs}`; `node_modules`/`.next`/`.git` excluded) found **4 markers, none actionable** — unchanged in character from prior weeks:

### 5a. Narrative / resolved-work references (4 matches)

- `app/api/rtr/lock-roi/route.ts:38` ("v2 folds in the two signals the v1 TODO called out — TIER and SERIAL"), `lib/rtr-lock-roi-weights.ts:7` ("resolves the standing … TODO"), `lib/chains/solana/normalize.ts:47` ("previously held as a TODO placeholder"), `lib/format.ts:6` (the `"$X,XXX.XX"` format doc — the `XXX` here is a format-string literal, the exact false positive the task names). All describe resolved work or are literals.

> **Net change since last week:** none of consequence. Live application code has zero actionable TODO markers. `TODO_`-prefixed launch-flag guard strings (which do not match `\bTODO\b`) and draft-doc `TODO(...) RESOLVED` lines persist by design. Vendored `workers/**/node_modules/` markers are third-party and excluded.

---

## 6. Resolved / no action needed

Verified against the register STATUS INDEX, the ledger, the sibling digest/handoff, and live DB reads:

**Newly resolved / landed since last week (2026-09-28 → 2026-10-04):**
- **#128** — the Top Shot fabricated-zero pack-rip pool **fully drained to 0** (live read 2026-10-05; was ~26,734).
- **Flowty re-promotion** — +143,575 chain-verified sales named from the chain (10-04); the previously-"unnamed" secondary sales are now mostly represented.
- **Top Shot team-Moment naming** — 590 team Moments named `<team> — <set>` with `player_name = team_name` (10-04).
- **Panini NO_DATA retirement** — a delisted ask no longer serves its price forever (10-04).
- **#171 parallel re-key** — 29,814 sales re-keyed onto their parallel edition (10-04, partly resolved).
- **Pack Sniper "Simulate" opened to anonymous** (10-04); **swap-test harness hardened** (per-tab wallet session, on-chain seal check).
- **R50** — 10 of 11 slow public boards back inside budget (10-04); the 11th left by decision.
- **fmv-backfill MATERIALIZED-CTE fix** (`20261005001848`) — a plan that walked the whole `sales` index to prove a true zero now finds candidates first (> 55s → 0.44s); holding.
- **Last week's #147** (duration-wrap) dropped off the open list (fixed on touch; no live effect).

**Note on churn:** the register grew 153 → 172 numbered items in one week; closed rose 117 → 132, open 2 → 5, partial 34 → 35. This was a discovery-heavy chain-truth week, not a scope change — most new slots are new-and-closed.

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the go-live bars:

1. **Action the #22 purge residue (Trevor):** ask GitHub Support to GC the unreachable objects and **rotate the Dapper session regardless** — branch deletion does not un-expose the blob by SHA, and the RS256 PII does not expire. Rotate `INGEST_SECRET_TOKEN` in the same pass. Oldest open P0.
2. **Run the `flowty_archive` SQL in the Supabase SQL editor:** `dedupe_tx_lane_20261004.sql` (keeps the walk row, refuses unless exactly 7) **then** `drop_scratch_20261004.sql`. Pre-checks verified live. Log each in the ledger the same turn.
3. **Rotate `ATLAS_POOL_INGEST_KEY` (#144)** and **retry the giveaway desktop delivery (#172)** (make `0x3d0b…` active, hard-reload, act on the hint line).
4. **Finish #169's exit** — re-measure the confidence mix on the 64 sell-back-only editions after the re-price, then **resume #167's lanes** and measure the estate-wide sell-back capture rate.
5. **Investigate #173** — find the `topshot_moment_subeditions` writer that produced the June 20 → July 6 conflated rows, correct `base_external_id` where spork roots agree, and re-key `sales`/`wmc`. Pricing-adjacent — Trevor/Claude Code.
6. **Get a clean WAU read** (exclude `internal_accounts` + the rewards `scout_wallet` test cohort) so the demand number means external users, then **drive one acquisition channel against the 50+ WAU gate (§2.1).**
7. **Re-point the Top Shot pack-supply page (#94)** from the frozen `topshot_pack_supply` to the new Atlas tables, then retire the HTTP-530 probe — needs the semantics decision first.
8. **Update the stale DB-size baseline doc** (4.2 GB June → cycling 22–34 GB) and keep the `net._http_response` bloat on watch.

---

## 8. Notes from verification

- **Sandbox / device shell active this run.** `git`/`grep`/`wc` all work over the connected repo; counts are first-hand. **1,240 commits** since 2026-09-28 (`git log --since`); tip `49e8c6178` 2026-10-05 00:43 PT (Trevor). Authors: Claude 924, Trevor 255, Cowork cloud 38, Cowork 16, autorecover/nightly bots ~7.
- **Counts measured this run:** CI = **20** jobs under `jobs:` in `.github/workflows/ci.yml` (changes, memory-docs, docs-tests, inherited-status, typecheck, eslint-ratchet, cadence-escrow-tests, unit-tests-shard, unit-tests, component-tests, workflow-lint, build-render, worker-tests, workers-typecheck, db-tests, ledger-guard, register-guard, inbox-guard, tree-corruption, edge-deno) — `cadence-lint` is gone vs last week's 21; DB-invariant test files = **252** (`supabase/tests/*.sql`, `ls`); `app/insights/*/page.tsx` = **31**. Monoliths re-measured (`wc -l`): DashboardClient 2,981 / SniperClient 2,081 / CollectionAnalyticsClient 2,022 / CollectionTabClient 1,596 / MarketClient 1,426.
- **Live DB reads 2026-10-05 (PT):** demand → **37** accounts / WAU **12** / MAU **18** / **165** saved wallets / **33**-of-37 with a saved wallet / **1** email sub (⚠ not excluding internal/QA or the rewards test cohort). DB size `sum(pg_database_size)` → **31,848 MB** (34.4 GB this morning per the digest; cycling). Accuracy legs from `rpc_trust_health_precompute` (TS 57.3, AllDay 27.8, Pinnacle 31.6, Candy 23.2, Golazos 1.0, UFC 0.0; `topshot_impossible_parallel_serials` 0, boards empty 0 / slow 1 [`panini_sale_feed_status`, by decision], `fmv_sanity_flags` 0). #128 drain: Top Shot `pull_value_usd = 0` → **0** (positive 283,506; null 612,020 = honest no-pull state).
- **Price backtest** (`fmv_sales_backtest`, 7d, from the overnight pass): Top Shot published median_ratio 1.000 / median abs err 13.0% / within-25% 71.8% (HIGH 9.1% err, within-25% 87.3%); All Day published ratio 1.20 / err 26.7% / within-25% 46.8% but median abs err $0.05 (sub-dollar market). Not independently recomputed this run.
- **TODO scan: 0 actionable markers in live app code** (§5) — `grep -rnE '\b(TODO|FIXME|HACK|XXX)\b'` with `node_modules`/`.next`/`.git` excluded; the one `XXX` hit is a `$X,XXX.XX` format literal.
- **Deletions verified by absence (`test -e`):** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` — all absent.
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`.
- **Cited paths spot-checked — all resolve, no stale references found:** `docs/strategy/{roadmap-2026-08-03,go-live-2026-09}.md`; `docs/reference/{known-issues,roadmap-status,database,cron-and-schedulers,key-files-and-honesty,testing-and-ci,schema-truth,architecture-notes,player-identity,chain-strategy}.md`; `docs/overnight/{ledger.md,metrics-latest.json,focus.md}`; `lib/{launch-flags,collections,address,api-error}.ts`; `lib/insights/board-status.ts`; `lib/analytics/fetch-json.ts`; `lib/og/board-empty-copy.ts`; `app/api/cron/{sales-serial-backfill,allday-lock-refresh-batch}/route.ts`; `app/api/golazos-offers-indexer/route.ts`; `app/insights/parallel-premiums/ParallelPremiumsBoardClient.tsx`; `components/TopNav.tsx`; `lib/swap-test/swap-wallet.ts`; `lib/giveaways/admin-wallet.ts`; `scripts/flowty-export/{dedupe_tx_lane_20261004,drop_scratch_20261004}.sql`; `scripts/flow-wallet-walk/drop_scratch.sql`; `lib/chains/panini/ingest-normalize.ts`; `.github/workflows/{ci.yml,edge-fn-deploy.yml}`. **Absent (correctly):** the four deleted product dirs, `lib/blazers-trivia.ts`, `docs/FREEZE.md`.
- **Known-issues STATUS INDEX:** its own generated line reads **172 numbered items — 5 open · 35 partial · 132 closed**; the 5 open are **#22, #167, #169, #172, #173**; the newest filed slots reach **#174**.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-10-05)

The register's own generated STATUS INDEX reports **172 numbered items — 5 open · 35 partial · 132 closed**. ⛔ `closed`/`open` means the item *says* so — read its own date stamp. Items that MOVED or are the current open set:

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 22 | 🚨 Credential purge | 🟡 **open** | Branch deleted; blob fetchable by SHA + RS256 PII persists — **GC + rotation owed to Trevor** | known-issues #22 |
| 128 | 82,864 fabricated-zero pack rips | 🟠 partial | **FULLY DRAINED** — Top Shot `pull_value_usd = 0` is 0 (live 10-05) | live DB read |
| 149 | undercut-NULL floor pool | 🟠 partial | Draining lane landed; exit watch carried | known-issues #149 |
| 160 | All Day price recovery | 🟠 partial | (a)/(d) closed; buyback promotion landed 10-01; (b) edition wait remains | known-issues #160 |
| 167 | Top Shot sell-backs missing from `sales` | 🟡 **open** | NEW 10-03 — capture rate unmeasured; exit = sample-window measure then ingest-or-decide | known-issues #167 |
| 169 | sell-backs counted as market sales | 🟡 **open** | NEW 10-03; **fix shipped 10-04** (`sales_market` view, 12 writers repointed); exit (re-measure the 64) pending | known-issues #169 |
| 171 | parallel moments under base edition | 🟠 partial | PARTLY RESOLVED 10-04 — 29,814 sales re-keyed; coverage gap remains | known-issues #171 |
| 172 | giveaway "Deliver all" desktop stall | 🟡 **open** | NEW 10-04 — extension path stalls; phone works; retry + hint-line owed | known-issues #172 |
| 173 | `topshot_moment_subeditions` wrong base edition | 🔴 **open** | NEW 10-04 — ≈1–1.5k rows; held-back sales mitigated, table not corrected | known-issues #173 |
| 94 | Top Shot pack-supply source | 🟠 partial | Source answered 10-03; re-point pack page + retire 530 probe left | known-issues #94 |
| 8 | sports-proxy 403 | — | SHELVED (Trevor delegation); alarm muted to 2026-10-28; do NOT retire | digest / known-issues #8 |
| 147 | `EXTRACT(MILLISECOND)` duration wrap | — | No longer on the open list (fixed on touch; no live effect) | STATUS INDEX |

**Tally (per the register's own STATUS INDEX):** **172 numbered items — 5 open · 35 partial · 132 closed**, newest slots to **#174**. Plus the go-live plan, the per-collection accuracy legs + the new out-of-sample price backtest, Candy live + Panini walked + Rewards paused, **20-job CI**, **252 DB-invariant test files**, and **31 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** this was a heavy chain-truth / correctness week. The register grew (153 → 172) on real discovery: the **Flowty re-promotion named +143,575 chain-verified sales**, **#128's fabricated zeros fully drained to 0**, Top Shot team Moments are named and attributable, and Dapper sell-backs no longer pollute FMV (#169). The live trust metrics are clean and five nightly passes were GREEN with 0 reverts. The open set is five — **#22** (credential-purge residue, P0, weeks old), **#167/#169** (two faces of sell-back handling, one fixed-pending-exit), **#172** (giveaway desktop delivery), and **#173** (Top Shot base-edition conflation). On the front page, **Top Shot is MET (57.3%) and now tracks the market out-of-sample; All Day is still short (27.8%)**, and **WAU read 12 but is inflated by internal/QA + rewards testing against a 50+ gate**. The standing asks are operator/Trevor: the **#22 purge GC + rotation**, the **`flowty_archive` dedupe + scratch-drop SQL**, the **#144 key rotation**, and the **#172 giveaway desktop retry**. **Demand — a clean one — is still the one number that decides everything.**
