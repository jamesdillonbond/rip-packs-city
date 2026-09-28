# Rip Packs City — Project Health Report

**Date:** 2026-09-28
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (generated STATUS INDEX, now reading **153 numbered items — 2 open · 34 partial · 117 closed**, running `#0–#155`, current through the 2026-09-27 entries), `docs/reference/roadmap-status.md`, `docs/strategy/go-live-2026-09.md` (M1–M11 bars + B1–B5 blockers), `docs/overnight/metrics-latest.json` (captured **2026-09-27 ~01:10 AM PT**, genuine overnight), `docs/overnight/ledger.md` (newest heading 2026-09-27), the sibling `weekly-health-digest-2026-09-28`, plus first-hand file-tool + shell scans (`git`, `grep`, `wc`) and **live DB reads (2026-09-28)** for demand, accuracy and DB size.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#155`), the go-live bars, the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-09-21.md` (7 days ago). This regeneration mirrors its structure. `_2026-09-14.md` … `_2026-05-22.md` (twenty-one prior reports) also live in `docs/health/`.

> ⚠ **LANDING CORRECTIONS (Claude Code, Windows box, 2026-09-28 PT).** This report was written untracked by the Cowork run, which did not touch git. It was re-checked against the ledger and live DB before it was committed. The body is kept as written, and stale claims are tagged inline with **[landing: …]**.
> 1. **Q0 `fmv_from_cached_listings` is NOT an open ask.** It SHIPPED 09-23 ~2 PM PT (`20260923205831`), with follow-ups `20260923220355` and the 2 h staleness bound `20260925152928`. The ledger's 09-24 landing note already says "Treat Q0 as closed". It came off the stale `metrics-latest.json` queue.
> 2. **`enrich-ufc-wallet` is deployed.** `edge-fn-deploy` deployed it 09-25 ~8:30 PM PT, the `?token=` branch was later deleted (step 3 of 3), and `DEPLOY_DEFERRED` is empty. The claim in §2.7 that the `compute-*-pack-ev` functions "remain in the drifted set" is also stale: per the ledger, `enrich-ufc-wallet` was the last content-drifted function.
> 3. **The TS active-listings feeder is NOT dark.** `topshot-active-listings-ingest` last ran at 6:13 AM PT on 09-28, with 4 runs in 24 h (live `pipeline_runs` read). The 09-28 nightly pass also recorded it as recovered. Per the 09-26 correction, the gap was the laptop being off, and nothing was owed on it.
> 4. **The register now reads 154 items: 2 open · 34 partial · 118 closed.** #156 (Pinnacle sale serials) was added and resolved after this run. The two open items are still #22 and #147.
> **So the Trevor asks that remain are #22 (GitHub GC + Dapper session + `INGEST_SECRET_TOKEN` rotation) and #144 (`ATLAS_POOL_INGEST_KEY` rotation).**

> **Biggest change since 2026-09-21 — this was a REGISTER-RECONCILIATION week: the open backlog collapsed and almost every hot item from last week closed.** The known-issue register went from **131 items (63 open · 18 partial · 50 closed)** to **153 items (2 open · 34 partial · 117 closed)**. Last week's live P0s and correctness finds are almost all resolved: **#128** (fabricated-zero pack rips) is down to ~26,734 zeros and draining on track (clears ~10-01); **#129** (Market-tab filters) RESOLVED 09-23; **#130** (Pinnacle-mints 403 secret) RESOLVED 09-20; **#131** (Candy double-count) RESOLVED 09-23; **#125** (Atlas transport) CLOSED 09-23; **#126** (cron-fleet busy-seconds) RESOLVED 09-20; **#55** (two disabled Routines) RESOLVED 09-23 — both **deleted**, Trevor's call; **#132**/**#133** (mobile tap targets / pills) both closed/accepted 09-23; **#64** (Panini `is_active`) RESOLVED 09-25; **#123** (collector-pack resales naming Dapper's escrow) RESOLVED 09-27 (a 10,236-row on-chain seller read, 0 read failures). Only **two items remain open**: **#22** (the credential-purge residue — still operator-only, still owed) and **#147** (a latent `EXTRACT(MILLISECOND …)` duration-wrap bug in seven functions, no live effect today). The audit cadence added a fresh batch of Pinnacle-grain and pricing correctness fixes (#150/#151/#155) and identity work (#137/#139).

> **Overnight reality — quiet and green.** The `metrics-latest.json` pass (2026-09-27 ~01:10 AM PT, Cowork cloud + laptop VM, push-capable) shipped **0**, reverted **0** — an honest quiet night. Verdict **GREEN**: security all `[]`; `trust_health` 38/38 ok, **0 breaches**; `sentinel_ts_uuid_editions_48h` 0; Sentry 0 new/24h; the client-error beacon read 11/24h, **all crawler UA** (not user-facing). The sibling weekly digest (2026-09-28) reports **three quiet green nights** (09-24 no-push, 09-26 queue-only, 09-27 green-quiet), **0 reverts** across the last 7 days. The one standing stall is **`topshot-active-listings-ingest`** — the live TS active-listings board's only feeder runs on Trevor's residential Windows box, dark since 09-26 16:13Z (visibility-only, does not page; the board goes stale while the box is off).

> **Traction reality — WAU 2 (live read 2026-09-28).** **30 total accounts (+2), WAU 2 (+1), MAU 8 (flat), 135 saved wallets (flat)**, 0 email subscribers, 27 of 30 users have a saved wallet. WAU nudged from 1 to 2; **n=2 is noise, not a trend**, and it remains flat against a 50+ gate. The digest adds a first faint external signal: **outbound clicks 4/7d (non-zero)**, portfolio snapshots 189/7d, concierge 42/7d (smoke-filtered). **WAU is still the one number that decides everything.**

> **Accuracy gate — Top Shot MET on the series, All Day NOT MET and not moving to the bar.** Read from `rpc_trust_health_history` (65-leg series since 2026-09-12) and `rpc_trust_health_precompute` (today's leg), live 2026-09-28: **M1 Top Shot 53.3% mean (43.5–59.2, 55 of 65 legs ≥ 50% — MET)**, today's leg 56.4; **M2 All Day 28.2% mean (21.2–31.7, 16 of 65 legs ≥ 30% — NOT MET)**, today's leg 25.1. ⚠ Last week's hope that the NFL-season volume bump would carry M2 over has **not** converted — the series mean is flat-to-down (28.7 → 28.2) and today's leg is below last week's. Per collection today: Candy **19.2%**, Pinnacle **30.6%** (up from 27.6 — the #150/#151/#155 Pinnacle fixes), Golazos 0.5%, UFC 0.0% (empty-market sentinel).

> ⚠ **Correction to a prior figure.** Last week's report listed **Candy ≈ 58%** HIGH/MED share. The live precompute reads **`candy_fmv_high_med_share_pct = 19.2`** today, and the raw counts corroborate it (`metrics-latest.json`: candy_mlb 23 HIGH+MED of 125 editions ≈ 18.4%). The ~58% figure is not reproducible from the live metric and is treated here as stale/erroneous; **19.2% is the honest current value**.

> **Cost / storage — cycling, not growing.** DB is **22,297 MB live (2026-09-28)** ≈ 22.0 GB. It read 30,574 (09-14), 19,759 (09-21) and 29,433 (09-27), and the digest documents it as **cycling 22–29 GB** on `net._http_response` TOAST churn — **documented, not chased**, and down from the 29.4 GB of the day before. The **SMALL → LARGE compute resize (09-20)** still stands; pipelines ran **99.9% success/24h** this week with **no saturation spell reported**, consistent with M11's structural constraint staying relaxed. Vercel build compute (#61, M10) is still to be re-measured at the next invoice.

> **Platform context (largely unchanged).** **(1)** Top Shot's public REST API stays dead; the Atlas backend read from the DB is the feed. Atlas `SearchMarketplaceTransactions` still answers a Cloudflare JS challenge (403) — designed-for and self-healing per the metrics (`atlas-market-upstream-403 info`). **(2)** Flowty frontend shut, API alive feeding ingest. **(3)** NFL All Day secondary-market only. **(4)** UFC Strike Flow market frozen (0 sales; honestly labelled, sentinel FMV). **(5)** Candy / Solana LIVE, thin. **(6)** Panini = WC Prizm plane (`PANINI_PUBLIC = true`), `is_active` decision closed (#64); the collector-walk shipped 09-27 (`jamesdillonbond` 146/146 cards, 12 unopened packs, complete).

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only) and the nightly pass run against this repo; shared state is in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` (absent this run → no freeze) halts all autonomous shipping. **Check `docs/overnight/ledger.md` and `docs/reference/known-issues.md` before acting.** ⚠ A separate autonomous **Claude Code review session on 09-25** shipped three fixes (Candy Packs ghost-floor, "my sealed packs" listed-count, Player-Editions badge failures stay visible) — revert paths in the weekly digest.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/strategy/go-live-2026-09.md` for the go-live plan. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Report location stays clean.** All twenty-two reports (this one included) live in `docs/health/`; the repo root holds none (verified this run).

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#155** | Register STATUS INDEX: **153 numbered items — 2 open · 34 partial · 117 closed**. ~22 new slots (#134–#155) since last week's `#0–#133`. See §9. |
| Known issues — resolved/closed since last week | **~25** | #55, #64, #123, #125, #126, #129, #130, #131, #132, #133, plus new-and-closed #134–142, #145, #146, #148, #151–155. — §6 / §9 |
| Known issues — open / partial | **36** | **2 open** (#22, #147) + **34 partial**. Collapsed from ~81 last week. — §3 / §9 |
| Known issues — 🚨 live trust breach | **0** | `topshot_impossible_parallel_serials` reads **0** (live 2026-09-28); `trust_health` 38/38 ok; boards empty 0 / slow 0. — §2.4 |
| Known issues — needs Trevor, operator | **few** | **#22** purge GC + rotate (P0, still owed); **#144** rotate `ATLAS_POOL_INGEST_KEY`; `enrich-ufc-wallet` CLI deploy; the TS active-listings feeder box (dark since 09-26). — §2.6 |
| Known issues — regressed / measured-dead (carried) | **1** | **#8 sports-proxy 403** — SHELVED 2026-09-23 under Trevor's delegation; alarm muted to 2026-10-13; deferred to preseason. — §2.3 |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent this run. |
| Go-live plan | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md`. Met: M1 (series), M3, M6, M7, M9. Below bar: M2, M4, M5, M8, M10, M11 (structurally relaxed by the resize). — §2.1 |
| Commits since last report | **812** | `git log --since 2026-09-21`. Authors: Claude 456, Claude (Cowork) 209, Trevor ~119, Claude Fable 5.1 22, autonomous/autorecover bots ~6. Tip `2815ee87` 2026-09-27 23:29 PT (Trevor). |
| Accuracy gate (headline metric) | **Series, per collection** | Top Shot **MET — 53.3% mean over 65 legs (43.5–59.2, 55/65 ≥ 50%)**, 56.4 leg today; All Day **NOT MET — 28.2% mean (21.2–31.7, 16/65 ≥ 30%)**, 25.1 leg today; Pinnacle 30.6; Candy 19.2; Golazos 0.5; UFC 0.0 (sentinel). Read the series, never a leg. |
| Demand (the critical-path number) | **WAU 2 · 30 accounts · 135 saved wallets** | Live 2026-09-28. WAU 1 → 2 (noise). MAU 8. Gate: **50+ WAU**. — §2.1 |
| Open overnight operational items | **standing queue** | #22 purge residue; #144 Atlas-pool key rotation; TS active-listings feeder box dark; the Q0 `fmv_from_cached_listings` mispricing awaiting review; `enrich-ufc-wallet` CLI deploy. — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana LIVE thin + Panini (WC Prizm, collector-walk shipped). — §2.8 |
| Prioritized next actions | **superseded** | `docs/strategy/roadmap-2026-08-03.md` (accuracy-is-the-gate) + `go-live-2026-09.md`. Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **0 actionable in live app code** | Measured this run (`grep`): 4 narrative/false-positive refs, +8 candy launch-flag `TODO_` note-branch refs, +4 draft-doc resolved/closed lines. — §5 |
| Test / DB-invariant pins | **221 `supabase/tests/*.sql` files** | +25 vs last week's 196 (measured this run, `ls`). |
| CI jobs (ci.yml) | **21** | Measured this run: +2 vs last week (added `build-render`, `workflow-lint`). See §8. |
| Public `/insights` surfaces | **30** | Measured this run: 30 `app/insights/*/page.tsx` dirs (flat). |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU. |

**Health read:** This was a reconciliation week — the open backlog collapsed from 63 to 2 and last week's live risks are almost all resolved, with no new fires. On demand, **WAU ticked 1 → 2 against a 50+ gate** — still noise, still the whole ballgame. On accuracy, **Top Shot is MET on the 65-leg series (53.3% mean) and All Day is NOT MET and no longer trending toward the bar** (28.2% mean, today's leg 25.1 below last week's 30.7 — the NFL-season optimism did not convert). The register cleanup is genuine work landing: **#128**'s fabricated-zero drain is on track (82,864 → ~26,734, clears ~10-01), **#123**'s escrow-seller defect was closed with a clean 10,236-row on-chain read, the **Pinnacle grain** family (#150/#151/#155) corrected character names, franchise checklists and render FMV (Pinnacle HIGH/MED share 27.6 → 30.6), and the two disabled Routines (#55) were resolved by **deletion**. The concentrated risk that remains: **(1) demand** — WAU 2, still everything; **(2) the two open items** — **#22** (credential-purge residue, P0 operator, unchanged for weeks) and **#147** (latent duration-wrap, no live effect); **(3) a HIGH stale-queue item** — the `fmv_from_cached_listings` mispricing (Q0) that republishes Flowty ASK_ONLY valuations up to ~20× above the live floor, off-limits to the autonomous pass and awaiting Trevor's review; **(4) operator hand-offs** — #144 key rotation, the dark TS active-listings feeder, `enrich-ufc-wallet` deploy.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public + self-serve. **WAU 2 / 30 accounts / 135 saved wallets (live 09-28).** Accuracy at/around its bars. The problem is still *demand*. Gate: **50+ WAU** (§2.1) |
| **Register reconciliation (REVERSAL)** | Open 63 → 2, partial 18 → 34, closed 50 → 117; ~25 items closed/resolved this week, most of last week's live risks among them (§9) |
| **Live trust breach still CLEAR** | `topshot_impossible_parallel_serials` 0 (live 09-28); `trust_health` 38/38; boards empty 0 / slow 0 (§2.4) |
| Data-intelligence correctness / honesty | #128 (fabricated-zero drain on track), #149 (undercut-NULL floor pool draining), #143 (entity "Floor" relabelled; real-ask option open), #155 (Pinnacle recency-median FMV), #150/#151 (Pinnacle grain) (§2.3) |
| Player / entity identity | #137 (Steph Curry merge + others), #139 (name pairs resolved vs NBA.com/NFL.com), #152/#153 (cross-collection nft_id + substitution fixes) (§2.3) |
| Chain foundation | Candy LIVE thin; Panini WC Prizm plane, `is_active` decided (#64), collector-walk shipped 09-27 (§2.8) |
| Operator-owned / hand-offs | #22 purge (P0); #144 `ATLAS_POOL_INGEST_KEY` rotation; TS active-listings feeder box dark; `enrich-ufc-wallet` CLI deploy; Q0 `fmv_from_cached_listings` review (§2.6) |
| Instrument darkness | #34 Sentry dark (beacon is the detector); #80 GitHub schedule-event drop; #100 master-alarm GHA trigger; #77 fleet-alarm channel (§2.5) |
| Security | scans clean; trust breach clear; #60 (can't revoke anon from net/cron schemas) carried, needs Supabase support (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent (§2.9) |
| SEO | #66 — zero external links, ~31K indexed pages rank on page N; off-platform, not code (§2.3) |
| Tech debt / refactor | Monoliths re-measured this run and all growing: DashboardClient **2,976** / CollectionAnalyticsClient **1,975** / SniperClient **1,961** / CollectionTabClient **1,587** / MarketClient **1,370** (§3) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled: no offer source); `INGEST_SECRET_TOKEN` rotation still owed |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is two layers: **`docs/strategy/roadmap-2026-08-03.md`** (accuracy is the GATE — headline metric is the HIGH/MEDIUM confidence share) and **`docs/strategy/go-live-2026-09.md`** (what "through the gate" means in numbers: M1–M11 bars, B1–B5 blockers, read as a series). The only user gate remains **50+ WAU**.

### 2.1 Launch + activation — Top Shot MET on the series, M2 stalled, demand still flat — `Severity: High · Effort: Medium (built + measured, needs traffic)`

The un-gate shipped 07-17; self-serve magic-link signup opened 07-20. Read-only tabs are anonymous for the 5 published Flow collections (+Candy overview, +Panini); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction, live read 2026-09-28:** **30 total accounts (+2), WAU 2, MAU 8, 135 saved wallets (flat)**, 0 email subscribers, 27 of 30 users have a saved wallet. WAU 1 → 2 is noise. The digest's outbound-clicks 4/7d is the first faint off-platform signal to watch.
- **Accuracy is a 65-leg series (`rpc_trust_health_history`, since 2026-09-12), read live 2026-09-28:** **M1 (Top Shot) 53.3% mean, range 43.5–59.2, 55 of 65 legs at/over the 50% bar — MET on the series.** **M2 (All Day) 28.2% mean, range 21.2–31.7, 16 of 65 legs at/over the 30% bar — NOT MET.** Today's single legs: M1 56.4, M2 25.1 — the file's own rule is *read the series, not the leg*.
- **M2 did not convert.** Last week's hypothesis was that returning NFL-season All Day volume would carry M2 over the bar. The series mean has instead drifted slightly down (28.7 → 28.2) and today's leg (25.1) is below last week's 30.7. The code-side levers remain small and are not the lever; M2 stays liquidity-limited.
- **Bar status (`go-live-2026-09.md` §3):** **Met** — M1 (on the series), M3, M6 (0 horizontal overflow at 390 px AND 320 px, both pinned), M7 (client-error detector), M9 (verification gate gone). **Below bar** — M2 (28.2% series vs ≥30%), M4 (cold latency), M5 (warm latency), M8 (E2E smoke consecutive-nights streak), M10 (Vercel build compute vs ≤40%, re-measure at invoice), M11 (DB saturation — **structurally relaxed by the 09-20 SMALL→LARGE resize**; no spell reported this week, 99.9% pipeline success).

Suggested next step unchanged: **pick one acquisition channel and run it against the 50+ WAU gate.** Still the single most important item in the whole report.

### 2.2 Public intelligence surfaces — 30 public — `Severity: n/a (shipped) · context`

All 30 built surface dirs in `app/insights/` are public (measured this run: 30 `page.tsx`). Carried honesty risks: `#50` (`/insights/pack-reality` ranker) and `#33` (ISR bakes a failed read into the `revalidate` window) both carried. Last week's `#129` (Market-tab Set/Series/Player/Min-price filters silently ignored on 4 of 5 collections) is **RESOLVED 09-23**; `#131` (Candy boards double-counted) **RESOLVED 09-23**.

### 2.3 Data-intelligence — drains on track, Pinnacle grain + FMV corrected, identity work — `Severity: Medium (correctness) · Effort: mixed`

**FMV HIGH/MEDIUM share (live legs, 2026-09-28):** Top Shot **56.4** (series mean 53.3, MET), All Day **25.1** (series mean 28.2, NOT MET), Pinnacle **30.6** (up from 27.6), Candy **19.2** (see the correction note in the summary), Golazos **0.5**, UFC **0.0** (empty-market SENTINEL, never a percentage).

**Shipped / found since last week:**

- **`#128` — the 82,864 fabricated-zero pack-rip drain is on track.** Top Shot `pull_value_usd = 0` went 82,864 → 53,134 (09-24) → **~26,734** (09-27, ~7,500/day, positive rows 258,876). Still projects clear ~10-01. The 10-01 re-read stands: if zeros are not under ~5,000, build the in-progress-dilution disclosure. Both writers remain all-or-nothing; the whole `COALESCE(SUM(...),0)` class was swept clean at the time of the find.
- **`#150` / `#151` — Disney Pinnacle read the wrong GRAIN.** Entity/market/sniper/set/series/character/franchise surfaces read `pinnacle_editions` (set-level, one character per key) instead of `pinnacle_catalog` (one row per pin). **RESOLVED 09-26** (12 migrations, readers moved to the catalog) and the **writer** re-created it after the readers were fixed — `backfill_pinnacle_wmc_metadata_from_editions` filled 33,000 holdings with the wrong or 'Unknown' character; **RESOLVED 09-27** (names from `pinnacle_catalog` by render_id; 0 'Unknown', 0 NULL). This is CLAUDE.md's "a read-layer fix does not close a fabrication the write layer can re-create," met again.
- **`#155` — Disney Pinnacle render FMV was a WAP-centred trimmed average** that dropped a falling render's recent sales as outliers (Minnie `OEEV1-EXPD-MINN-E2`: $21.56 MEDIUM against $3/$6 sales, leading the Sniper as a false "deal"). **RESOLVED 09-27** — now a recency-weighted median (backtest error 19.0% → 9.4%; Minnie → $8; renders > 2× their 30-day max sale 7 → 1). Pinnacle HIGH/MED share moved 27.6 → 30.6.
- **`#149` — the Top Shot `edition_offers.low_ask` undercut-NULL floor pool is draining.** A quiet cheap listing aged out of the 24 h Atlas window while dearer ones stayed, so 1,233 published floors were undercut by open listings under half their value; those are NULLed and a priority re-verify lane (6/tick) drains the pool (1,148 → 377 over ~29 h, ~26 editions/hr). Exit re-read ~09-29.
- **`#143` — entity-page "Floor" relabelled.** The team/player/set/series strips now read "Recent-Low Total" / "Recent Low" ("Lowest recent sale or ask — not a live floor") rather than "Floor," pinned by a ban-at-zero test. Option (b) — reading a real per-collection ask so a cell can say "Floor" truthfully — stays open.
- **Player / entity identity — `#137`, `#139`, `#152`, `#153`.** #137 merged "Stephen Curry" into "Steph Curry" (123 editions) and shipped Trevor's other identity calls; #139 resolved name pairs against NBA.com/NFL.com (two people stay two rows, one person spelled two ways becomes one + aliases, mixed rows split by edition); #152 fixed trophy-slab acquisitions read unscoped by `nft_id` (the #142 cross-collection class); #153 fixed `/api/profile/top-moments` widening an unknown `?collection=` to every collection (substitution).

**Carried / open:**

- **`#8` — sports-proxy 403 — SHELVED 2026-09-23** under Trevor's delegation ("no paid projections provider before revenue"). Alarm muted to 2026-10-13; fails safe (no bad rows). Do NOT retire (sole writer for `nba_players`/projections).
- **`#66` — SEO:** zero external links, ~31K indexed pages rank on page N. Off-platform authority problem, not a code fix.
- **`#116` — base-edition impossible serials (partial):** 1,727 rows / 73 editions carry a serial their edition cannot contain; the trust metric is parallel-scoped so reads 0. Do NOT widen the metric; the decisive chain read is owed.

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (clean scans; 0 live breaches) · Effort: mostly landed`

- **Security scans clean** (invariants, anon-write, rls-off-base-tables, secdef-anon all `[]`; per the 09-27 metrics and the 09-28 digest: 0 public base tables with RLS off, 0 anon write-holes).
- **Live trust breach clear.** `topshot_impossible_parallel_serials` reads **0** (live 2026-09-28); `trust_health` 38/38 ok, `public_board_empty_count` 0, `public_board_slow_count` 0, `fmv_sanity_flags` 0.
- **`#142` — impossible-serial sales RESOLVED 09-27.** Last-30-day serials above the base+parallels ceiling: 0; the residue is historical, on-chain-explained and hidden.
- **`#22` — the credential-purge residue is STILL OPEN (P0, operator-only).** The leak branch was deleted from origin 2026-09-08 (re-derived done by live read 09-19: the `e4tib3` branch is gone, only `qi4350` remains and reads clean), but the pre-purge blob stays fetchable **by SHA** until GitHub Support GCs the unreachable objects, and the RS256 token PII does not expire. **Ask GitHub Support to GC, and rotate the Dapper session regardless.** `INGEST_SECRET_TOKEN` rotation (~15 functions) also still owed. Unchanged for weeks.
- **`#147` — NEW, OPEN (latent).** Seven SQL functions compute `elapsed_ms` with `EXTRACT(MILLISECOND[S] FROM interval)`, which returns only the seconds field ×1000 (0–59,999), so any run ≥ 60 s logs a wrapped duration. Over 72 h every affected pipeline finished under 60 s (max wall 14 s), so **no live value is wrong today** — a pinned-DDL migration for zero observed effect. Fix when one of these is next touched: `(EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::int`.
- **`#60` (carried):** Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas; real fix needs Supabase support.
- **DB-invariant SQL layer: 221 `supabase/tests/*.sql` files** (+25, measured this run). CI is **21 jobs** in `ci.yml`. **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

⚠ **`#34` — Sentry dark since 2026-08-18; no-spend DECIDED** — the `window.onerror`/rejection beacon → `usage_events.client_error` is the detector (11 events/24h this week, all crawler UA). ⚠ **`#80`** — GitHub schedule-event drop (partly mitigated). ⚠ **`#77`/`#100`** — the fleet alarm's channel and the master alarm's GHA trigger reliability (decided: move alarms off GHA / multi-channel). ⭐ **`#62`** — the true-mobile QA instrument (`scripts/qa/mobile-sweep.mjs`, real Chromium at 390/320 px) remains the only real mobile instrument.

### 2.6 Overnight operational queue — `Severity: Low–High (mixed) · Effort: mixed`

Health scans GREEN (0 new stalled pipelines; 1 standing operator stall). Open items:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **#22 — credential-purge residue** | Branch deleted; blob still fetchable by SHA; RS256 PII does not expire. | **P0 (operator)** | GitHub Support GC + rotate the Dapper session regardless; `INGEST_SECRET_TOKEN` too. |
| **TS active-listings feeder box dark** **[landing: RECOVERED — last run 09-28 6:13 AM PT]** | `topshot-active-listings-ingest` (residential Windows box) silent since 09-26 16:13Z; the live TS active-listings board goes stale. | Med (operator, visibility) | Wake the box. Recurring; does not page. |
| **#144 — rotate `ATLAS_POOL_INGEST_KEY`** | The `?key=` branch is deleted + deployed (header-only, pinned); the key was in logs. | Med (operator) | Rotate the edge secret + Trevor's user env var. |
| **Q0 — `fmv_from_cached_listings` mispricing** **[landing: SHIPPED 09-23 — closed]** | Republishes Flowty ASK_ONLY valuations up to ~20× above the live floor on the FMV surface ($1M troll floors, unscoped DELETE). Off-limits to the autonomous pass (FMV route). | **High (review)** | A ready-to-run fix is in the 09-23 handoff/inbox; digest recommends SHIP IT with Trevor's review. |
| **`enrich-ufc-wallet` CLI deploy** **[landing: DEPLOYED 09-25]** | Carried operator deploy. | Med (operator) | Cowork cannot deploy it. |
| **#8 sports-proxy 403** | SHELVED 09-23; alarm muted to 2026-10-13. | Med (operator, deferred) | Do NOT retire. |

> Note: the `metrics-latest.json` (09-27 ~1:10 AM PT) `needs_trevor` list also names `#123`/`#134` (`wrangler deploy pack-events-ingest`) and `#140` — both closed later the same day (09-27), so they are resolved rather than owed. `#55` (two disabled Routines) and `#64` (Panini `is_active`) are likewise resolved since that snapshot.

### 2.7 Pack EV / pack-viz — `Severity: Medium (correctness, draining) · Effort: mostly landed`

Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. **#128's fabricated-zero drain continues** (see §2.3), on track to clear ~10-01; the residual dilution is time-bounded and undisclosed on-surface pending the 10-01 re-read. `pack_ev_publish_shortfall_pct` reads 0.79 today (well within tolerance). The `compute-*-pack-ev` edge functions remain in the drifted set (operator-gated redeploy). **[landing: stale — the drift set was emptied 09-25.]**

### 2.8 Chain foundation — Candy LIVE, Panini decided + walked — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — LIVE, THIN:** `CANDY_MLB_PUBLIC = true` (verified this run), overview tab. `#131` (board double-count) and `#145` (escrow remap) resolved 09-23/09-27.
- **Panini — the WC Prizm plane** (`PANINI_PUBLIC = true`, verified this run). `#64` `is_active` decision closed 09-25. `#136` (1.1.0 FMV engine) closed 09-25. The **collector-walk shipped 09-27** (`jamesdillonbond` 146/146 cards + 12 unopened packs, complete) — reads Panini's public profile in the runner's Chrome, attributes answers only when the request names the user. Still needs a `git pull` on Trevor's box to run for other users.
- **Chain-abstraction Phases A–F complete.** Cloudflare worker dirs carried (not re-counted).

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** — verified this run by absence: `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift` all absent (plus `lib/blazers-trivia.ts`, `docs/FREEZE.md`). The product is purely read-only.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/resolved status of the items that moved this week.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** **WAU 2 / 30 accounts / 135 saved wallets (live 09-28)** — flat. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| — | **Go-live bars M1–M11.** Met: M1 (series), M3, M6, M7, M9. Below bar: M2, M4, M5, M8, M10, M11 (relaxed). | High | Mixed |

### Security / operator (the two open items + P0)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 22 | 🚨 Credential purge — branch deleted, blob still fetchable by SHA; RS256 PII persists. Rotate regardless. | **P0 (operator)** | GitHub GC + rotation |
| 147 | Latent `EXTRACT(MILLISECOND …)` duration wrap in 7 functions; no live value wrong today. | Low (latent) | Small (fix on next touch) |

### Data-intelligence correctness / honesty

| Item | Issue | Severity | Effort |
|---|---|---|---|
| 128 | Fabricated-zero pack rips draining on track (~26,734 left; clears ~10-01). | **Medium** | Mostly landed; re-read 10-01 |
| 149 | Top Shot undercut-NULL floor pool draining (6/tick); exit re-read ~09-29. | Medium | Landed; watch |
| 143 | Entity "Floor" relabelled; real-ask option (b) open. | Low–Med | Small–Medium |
| 116 | Base-edition impossible serials (1,727 / 73); trust metric blind; chain read owed. | Medium | Investigation (do NOT widen metric) |
| 155 / 150 / 151 | Pinnacle render FMV recency-median; entity/writer grain corrected. | Medium | Landed |
| 66 | Zero external links; ~31K indexed pages rank on page N. | Med | Off-platform (not code) |

### Instruments / darkness / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 144 | Rotate `ATLAS_POOL_INGEST_KEY` (was in logs); `?key=` branch deleted + deployed. | Med (operator) | One rotation |
| — | TS active-listings feeder (residential Windows box) dark since 09-26. | Med (operator) | Wake the box |
| 34 / 80 / 77 / 100 | Sentry dark (beacon is detector); GitHub schedule-event drop; fleet alarm channel; master alarm GHA trigger. | Med | Move alarms off GHA / multi-channel |
| 60 | Cannot revoke anon/authenticated from net/cron schemas; needs Supabase support. | Low–Med | External |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 / 10 | Monolith page refactor — re-measured this run and all growing: DashboardClient **2,976**, CollectionAnalyticsClient **1,975**, SniperClient **1,961**, CollectionTabClient **1,587**, MarketClient **1,370** (under `app/(collections)/[collection]/*`; DashboardClient under `app/dashboard/`). | Low–Medium | Large |

### Stalled / scaffolded + deferred hardening

- Cart / Trade Hub / Gifting — **DELETED, verified still absent.**
- Deferred hardening (intentional): `email_subscribers`/`outbound_clicks`/`portfolio_snapshots`/`support_conversations` public INSERT policies; `user_achievements`+`watchlist_items` still on `owner_key` (text); Golazos `highest_offer` gap SETTLED (no offer source — do NOT build the indexer); `INGEST_SECRET_TOKEN` still to be rotated (Trevor, ~15 functions).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query.
- **Supabase compute is `LARGE`** (resized from SMALL 2026-09-20). Any pre-09-20 finding citing the SMALL-tier disk-IO floor (e.g. 22 MB/s) is stale — re-derive.
- **Disney Pinnacle grain:** a pin = a `pinnacle_catalog` row (`render_id`); `pinnacle_editions` is set-level and its `external_id` matches no held key. Readers AND writers must use the catalog (#150/#151).
- **A function-level `SET statement_timeout` is INERT on pg_cron** (`#43`).
- **Eight caller sources** — including a Windows Scheduled Task on Trevor's box and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old list is replaced by **`docs/strategy/roadmap-2026-08-03.md`** (accuracy-is-the-gate) and **`docs/strategy/go-live-2026-09.md`** (the numbers + the series):

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM share must beat incumbents.** | **Top Shot MET on the 65-leg series (53.3% mean); All Day NOT MET (28.2%) and not trending up. Read as a series.** |
| Go-live | **M1–M11 bars.** | Met: M1, M3, M6, M7, M9. Below bar: M2, M4, M5, M8, M10, M11 (relaxed). |
| 1 | **Prove the product with real users — 50+ WAU.** | **Open — the critical path. WAU 2 (live 09-28).** |
| 2 | Cost / latency / saturation levers. | **Stable — DB cycling 22–29 GB (TOAST), tier LARGE, 99.9% pipeline success; re-measure Vercel build at invoice.** |
| 3 | Durable debt. | Heavy advance — register open 63 → 2; #128 drain on track, Pinnacle grain/FMV + identity fixes, #149 floor drain. |
| 4 | Chain two, readiness-gated. | Candy LIVE (thin); Panini decided + collector-walk shipped. |

**Standing guardrails:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight sources).

**Housekeeping still outstanding** **[landing: of these, Q0, `enrich-ufc-wallet` and the feeder box are already resolved]**: action the #22 purge GC + credential rotation (and `INGEST_SECRET_TOKEN`); rotate `ATLAS_POOL_INGEST_KEY` (#144); wake the TS active-listings feeder box; decide the Q0 `fmv_from_cached_listings` fix; deploy `enrich-ufc-wallet`; re-read #128 (~10-01) and #149 (~09-29).

---

## 5. In-code TODO inventory

A first-hand `grep -rnE '\b(TODO|FIXME|HACK|XXX)\b'` over `app/ lib/ components/ scripts/ workers/` (`*.{ts,tsx,js,jsx,mjs,cjs}`; node_modules/.next/.git excluded) found **4 markers, none actionable** — unchanged in character from prior weeks:

### 5a. Narrative / resolved-work references (4 matches)

- `app/api/rtr/lock-roi/route.ts:38` ("v2 folds in the two signals the v1 TODO called out — TIER and SERIAL"), `lib/rtr-lock-roi-weights.ts:7` ("resolves the standing … TODO"), `lib/chains/solana/normalize.ts:47` (describes a former TODO placeholder), `lib/format.ts:6` (the `"$X,XXX.XX"` format doc — the `XXX` here is a format-string literal, the exact false positive the task names). All describe resolved work or are literals.

### 5b. Candy launch-flag-gated `TODO_` note-branch refs (8 refs) — keep by design

- `app/api/candy-sales-indexer/route.ts`, `app/api/ingest/candy-editions/route.ts`, and `lib/chains/solana/normalize.ts` — `TODO_`-prefixed placeholder strings and `startsWith("TODO_")` readiness-guard functions inside launch-flag-gated defensive branches. `TODO_` does not match `\bTODO\b`; these are guards, not open work.

### 5c. Panini draft/reference lines — draft-only, all closed (4 refs)

- `docs/drafts/**` — annotated `TODO(...) RESOLVED/CLOSED` draft scaffolding.

> **Net change since last week:** none of consequence. Live application code has zero actionable TODO markers. Vendored `workers/**/node_modules/` markers are third-party and excluded by the glob.

---

## 6. Resolved / no action needed

Verified against `docs/reference/known-issues.md` STATUS INDEX and `docs/overnight/metrics-latest.json`:

**Carried, still resolved:** the full closed set is now **117 items** (`#0–#155`). The pre-existing resolved slate carries; see `PROJECT_HEALTH_2026-09-21.md` §6 for the enumerated carry-forward. ⚠ **#8 is CLOSED as SHELVED 2026-09-23** (Trevor's delegation), replacing last week's "regressed / measured-dead" framing.

**Newly resolved / closed since last week (2026-09-22 → 2026-09-27):**
- **#55** two disabled 2-hourly Routines — RESOLVED 09-23 (both **DELETED**, Trevor's call — not re-enabled).
- **#64** Panini `is_active` decision — RESOLVED 09-25.
- **#123** collector-pack resales naming Dapper's escrow — RESOLVED 09-27 (10,236-row on-chain seller read, 0 read failures, 1,140 distinct sellers).
- **#125** Atlas transport Cloudflare 403 — CLOSED 09-23 (own first-tick falsifier).
- **#126** cron-fleet busy-seconds ~10× — RESOLVED 09-20.
- **#129** Market-tab filters silently ignored — RESOLVED 09-23.
- **#130** `ingest-pinnacle-mints` 403 secret — RESOLVED 09-20.
- **#131** Candy boards double-counted — RESOLVED 09-23.
- **#132** ~3,900 sub-44px tap targets — CLOSED/ACCEPTED 09-23 (product decision: keep board rows as-is).
- **#133** filter pills hit-test to another element — CLOSED 09-23.
- **#134–142, #145, #146, #148, #151–155** — new-and-closed this week: pack-purchase shop-labelling (#134), Golazos pack-sales history (#135), Panini 1.1.0 FMV (#136), player-identity calls (#137/#139), mega-wallet decision (#138), cold-population FMV (#140), Candy FMV resync (#141), impossible-serial sales (#142), Candy escrow remap (#145), listing-sort/floor labelling (#146), profile strict-owner (#148), Pinnacle grain writer (#151), trophy-slab nft_id scope (#152), top-moments substitution (#153), a CI false-positive (#154), Pinnacle recency-median FMV (#155).

**Note on churn:** the register grew from 131 to 153 numbered items in one week (`#0–#133` → `#0–#155`); the closed count rose 50 → 117 and open fell 63 → 2. Heavy audit/close cadence and a deliberate reconciliation, not a change in scope.

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the go-live bars:

1. **Action the #22 purge residue (Trevor):** ask GitHub Support to GC the unreachable objects and **rotate the Dapper session regardless** — branch deletion does not un-expose the blob by SHA, and the RS256 PII does not expire. Rotate `INGEST_SECRET_TOKEN` in the same pass. This is the oldest open P0.
2. **[landing: DONE — shipped 09-23; skip.]** **Decide the Q0 `fmv_from_cached_listings` fix.** It republishes Flowty ASK_ONLY valuations up to ~20× above the live floor on a user-facing FMV surface; the fix is ready in the 09-23 handoff and is off-limits to the autonomous pass. Ship with review.
3. **Rotate `ATLAS_POOL_INGEST_KEY` (#144)** and **wake the TS active-listings feeder box** so the live board stops going stale.
4. **Re-read the two draining items on schedule:** #149 (undercut-NULL pool, ~09-29) and #128 (fabricated-zero pack rips, ~10-01; build the dilution disclosure only if zeros are not under ~5,000).
5. **Drive traffic against the 50+ WAU gate (§2.1).** The accuracy bars are close enough that demand is the binding item; pick one channel.
6. **Re-read M2 off the series after a full clean NFL week** (`rpc_trust_health_history`) — it did not convert this week, so confirm whether it is genuinely stalled below the bar.
7. **[landing: DONE 09-25.]** **Deploy `enrich-ufc-wallet`** and clear the remaining operator-gated edge-function redeploys.
8. **Verify the cost mitigations at the next invoice** (Vercel build machine, M10).

---

## 8. Notes from verification

- **Sandbox / device shell active this run.** `git`/`grep`/`wc` all work over the connected repo; commit counts and line counts are first-hand. **812 commits** since 2026-09-21 (`git log --since`); tip `2815ee87` 2026-09-27 23:29 PT (Trevor). Authors: Claude 456, Claude (Cowork) 209, Trevor ~119, Claude Fable 5.1 22, autonomous/autorecover bots ~6.
- **Counts measured this run:** CI = **21** jobs under `jobs:` in `.github/workflows/ci.yml` (changes, memory-docs, docs-tests, inherited-status, typecheck, eslint-ratchet, cadence-lint, cadence-escrow-tests, unit-tests-shard, unit-tests, component-tests, **workflow-lint** [new], **build-render** [new], worker-tests, workers-typecheck, db-tests, ledger-guard, register-guard, inbox-guard, tree-corruption, edge-deno); DB-invariant test files = **221** (`supabase/tests/*.sql`, `ls`); `app/insights/*/page.tsx` = **30**. Monoliths re-measured (`wc -l`): DashboardClient 2,976 / CollectionAnalyticsClient 1,975 / SniperClient 1,961 / CollectionTabClient 1,587 / MarketClient 1,370 (also PackLifecycleClient 1,070, CollectionSetsClient 1,027).
- **Live DB reads 2026-09-28 (PT):** demand `SELECT` over `auth.users` / `saved_wallets` / `email_subscribers` → **30** accounts / WAU **2** / MAU **8** / **135** saved wallets / **27**-of-30 with a saved wallet / **0** subs; DB size `sum(pg_database_size)` → **22,297 MB**. Accuracy legs from `rpc_trust_health_precompute` (TS 56.4, AllDay 25.1, Pinnacle 30.6, Candy 19.2, Golazos 0.5, UFC 0.0; `topshot_impossible_parallel_serials` 0, boards empty 0 / slow 0, `fmv_sanity_flags` 0).
- **Accuracy SERIES** is the 65-leg `rpc_trust_health_history` read live 2026-09-28, since 2026-09-12 (M1 53.3% mean, 55/65 ≥ 50; M2 28.2% mean, 16/65 ≥ 30); today's single legs are labelled as legs, per the file's *read-the-series-not-the-leg* rule.
- **TODO scan: 0 actionable markers in live app code** (§5) — `grep -rnE '\b(TODO|FIXME|HACK|XXX)\b'`; the one `XXX` hit is a `$X,XXX.XX` format literal.
- **Deletions verified by absence (`ls`):** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` — all absent.
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`.
- **Cited paths spot-checked — all resolve, no stale references found:** `docs/strategy/{roadmap-2026-08-03,go-live-2026-09}.md`; `docs/reference/{known-issues,roadmap-status,database,cron-and-schedulers,key-files-and-honesty,testing-and-ci,schema-truth,architecture-notes,player-identity,chain-strategy}.md`; `docs/audits/deep-audit-register.md`; `docs/overnight/{ledger.md,metrics-latest.json,focus.md}`; `components/telemetry/ClientErrorBeacon.tsx`; `scripts/qa/mobile-sweep.mjs`; `e2e/mobile-layout.spec.ts`; `lib/{launch-flags,collections,address,api-error}.ts`; `lib/insights/board-status.ts`; `lib/analytics/fetch-json.ts`; `lib/og/board-empty-copy.ts`; `lib/sentinel/clock-store.ts`; `components/entity/_shared.tsx`; `.github/workflows/{ci.yml,edge-fn-deploy.yml}`; `supabase/functions/ingest-topshot-atlas-pool/index.ts`; `workers/pack-events-ingest`; and the item-cited tests `__tests__/entity-recent-low-is-never-labelled-floor.test.ts`, `__tests__/atlas-pool-ingest-reads-header-only.test.ts`, `scripts/atlas-pool-harvest.ps1`, `supabase/tests/{backfill_pinnacle_wmc_metadata_from_editions,pinnacle_readers_use_the_pin_catalog,sync_edition_offers_from_atlas}.sql`. **Absent (correctly):** the four deleted product dirs, `lib/blazers-trivia.ts`, `docs/FREEZE.md`.
- **Known-issues STATUS INDEX:** its own generated line reads **153 numbered items — 2 open · 34 partial · 117 closed**, running `#0–#155`, derived from each item's own first sentence.
- ⚠ **A prior figure was corrected:** last week's Candy HIGH/MED share (~58%) does not reproduce; the live metric is 19.2% and the raw counts (23/125) corroborate it. Recorded in the summary and §2.3.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-09-28)

The register's own generated STATUS INDEX reports **153 numbered items — 2 open · 34 partial · 117 closed**, running `#0–#155`. ⛔ `closed` means the item *says* it is closed — read its own date stamp. Items that MOVED this week:

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 8 | sports-proxy 403 | ✅ closed | SHELVED 2026-09-23 (Trevor delegation); alarm muted to 2026-10-13; do NOT retire | known-issues #8 |
| 22 | 🚨 Credential purge | 🟡 **open** | Branch deleted (re-derived 09-19); blob fetchable by SHA + RS256 PII persists — **GC + rotation owed to Trevor** | known-issues #22 |
| 55 | 2-hourly Routines | ✅ closed | RESOLVED 09-23 — both **DELETED** | known-issues #55 |
| 64 | Panini `is_active` | ✅ closed | RESOLVED 09-25 | known-issues #64 |
| 116 | base-edition impossible serials | 🟠 partial | PARTLY RESOLVED 09-25; chain read still owed; do NOT widen metric | known-issues #116 |
| 123 | pack resales name Dapper escrow | ✅ closed | RESOLVED 09-27 — 10,236-row on-chain seller read, 0 failures | known-issues #123 |
| 125 | Atlas transport 403 | ✅ closed | CLOSED 09-23 (first-tick falsifier) | known-issues #125 |
| 126 | cron fleet busy-seconds ~10× | ✅ closed | RESOLVED 09-20 | known-issues #126 |
| 128 | 82,864 fabricated-zero pack rips | 🟠 partial | Draining on track — ~26,734 left (09-27); clears ~10-01 | known-issues #128 |
| 129 | Market-tab filters ignored | ✅ closed | RESOLVED 09-23 | known-issues #129 |
| 130 | ingest-pinnacle-mints 403 | ✅ closed | RESOLVED 09-20 | known-issues #130 |
| 131 | Candy boards double-counted | ✅ closed | RESOLVED 09-23 | known-issues #131 |
| 132 | ~3,900 sub-44px tap targets | ✅ closed | ACCEPTED 09-23 (product decision) | known-issues #132 |
| 133 | pills hit-test to another element | ✅ closed | CLOSED 09-23 | known-issues #133 |
| 143 | entity "Floor" not a floor | 🟠 partial | PARTLY RESOLVED 09-25 — relabelled; real-ask option (b) open | known-issues #143 |
| 144 | Atlas-pool `?key=` + key rotation | 🟠 partial | PARTLY RESOLVED 09-26 — header-only deployed; rotate `ATLAS_POOL_INGEST_KEY` (Trevor) | known-issues #144 |
| 147 | 🆕 `EXTRACT(MILLISECOND)` duration wrap | 🟡 **open** | NEW 09-26 — latent in 7 functions; no live value wrong today | known-issues #147 |
| 149 | undercut-NULL floor pool | 🟠 partial | PARTLY RESOLVED — pool draining (6/tick); exit re-read ~09-29 | known-issues #149 |
| 150 / 151 | Disney Pinnacle grain (readers + writer) | ✅ closed / ✅ closed | RESOLVED 09-26 (readers) + 09-27 (writer) | known-issues #150/#151 |
| 155 | Pinnacle render FMV recency-median | ✅ closed | RESOLVED 09-27 — WAP trimmed-mean → recency-weighted median | known-issues #155 |

**Tally (per the register's own STATUS INDEX):** **153 numbered items — 2 open · 34 partial · 117 closed**, running `#0–#155`. Plus the go-live plan (M1–M11 / B1–B5, read as a series), the per-collection accuracy series, Candy live + Panini decided/walked, **21-job CI**, **221 DB-invariant test files**, and **30 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** this was a reconciliation week — the open backlog collapsed from **63 to 2** (only **#22** credential-purge residue and **#147** a latent duration-wrap remain), and almost every hot item from last week's report resolved: **#128** draining on track, **#123** escrow-seller closed on a clean 10,236-row chain read, the **Pinnacle grain** family (#150/#151/#155) corrected character names, franchise checklists and render FMV (Pinnacle HIGH/MED share 27.6 → 30.6), and **#55**'s two dead Routines resolved by deletion. The audit cadence stayed heavy and clean — three quiet green nights, 0 reverts. On the front page, **Top Shot is MET on the 65-leg accuracy series (53.3% mean) and All Day is NOT MET and did not convert** (28.2% mean, today 25.1), and **WAU is 2 against a 50+ gate**. The standing asks are all operator/Trevor: the **#22 purge GC + rotation** (weeks old), the **Q0 `fmv_from_cached_listings` mispricing** review, the **#144 key rotation**, and the **dark TS active-listings feeder box**. **Demand is still the one number that decides everything.**
