# Overnight pass — 2026-10-27 (~1:05 AM PT)

**Session:** rpc-nightly-overnight (Cowork cloud, laptop-VM clone push via `.rpc-git-cred`).
**Verdict:** 🟢 GREEN. 0 production shipped, 0 reverted. Queue-only night — the whole collection surface is hot (CC's All Day / Candy / Pinnacle / Panini parity push, 10-25→10-26), and nothing clean-safe + non-hot + independently verifiable was open.
**Gates:** lock acquired (prev RELEASED, clean); no FREEZE; push available (dry-run up-to-date); real time confirmed via DB `now()` 08:05Z ≈ shell 08:04Z (no skew) → 01:05 AM PT = genuine overnight window, normal shipping allowed.

## Reviewed
- **Inbox drained (3 new since the 10-26 08:05Z pass):**
  - `2026-10-26T1806Z` + `2026-10-26T2112Z` — Candy upstream read-timeout cluster (candy-listings/sales/offers, 12:xx–18:xxZ afternoon). **DISPOSITION: self-cleared overnight, closed, no action.** `candy-listings-indexer` last fail 10-26 18:35Z then OK through 06:35Z; `candy-offers-indexer` last fail 18:50Z→OK 06:50Z; `candy-sales-indexer` last fail 12:20Z→OK. Matches the inbox's own "if it self-cleared overnight, close with a one-line note" path. Candy is the #58 Trevor-only frozen book; listings/offers/fmv all fresh.
  - `2026-10-27T0309Z` — hot-floors read-bound on the All Day / Panini parity deploy. **DISPOSITION: QUEUED for Claude Code (hot, CC-owned, in-flight surface).** See Queued #HF below.
  - (Inbox left untouched — append-only. Dispositions recorded here per the rule.)
- **Post-ship regression watch (last ~24–48h ships were all CC's parity passes; the autonomous pass shipped 0 on 10-26):**
  - **Smoke-test HARD FAILURE 05:27–05:30Z (`check_public_security_invariants`: 2 All Day views `view_unexpected_definer`: `allday_first_mint_trophies`, `allday_first_mint_trophy_stats`) — RESOLVED, verified.** Transient during CC's parity-pass-4 deploy: views created ~05:17Z (mig `20261027051708`), smoke caught them security_definer, CC's own follow-up `20261027053839` set `security_invoker` ~05:38Z (~8 min later). Verified NOW: `check_public_security_invariants()` = `[]`; both views carry `security_invoker=on`. No open finding.
  - **hot-floors read-bound (All Day 02:34Z + Panini 02:36Z, base route 02:34Z):** all on deploy `a33bf9e8` (parity pass 1), each count=1, degrades to EMPTY (no hard user error). Current prod `02733b7c7` (live since ~06:16Z) — **0 recurrence in the ~2h since.** Queued, not shipped (below).
  - **ULTIMATE FMV retirement / reliable-tier accuracy:** no FMV-route change shipped this pass; trust-health FMV legs all OK (`topshot_fmv_pct_stale_30d` 0, `fmv_sanity_flags` 0, `fmv_sweep_stall_pct_24h` 4, `fmv_sweep_wedge_hours` 0.19); HIGH counts stable (nba 1419→1409, panini 16778→16859). No regression.
  - **Prod deploys:** current `dpl_nfjQxxinJt91FtJbkmELckNBn7rw` @ `02733b7c7` READY = origin/main HEAD. Last 6 prod deploys: 4 READY / 2 CANCELED (superseded by rapid pushes), 0 ERROR.
- **Dashboards:** none flagged broken/stale by the monitor (03:09Z: all dashboard-referenced relations+functions present, 0 missing). No repair needed; Artifact tool not exercised.

## Section 2 health-drift findings + deltas (vs metrics-latest 10-26)
- **Security:** CLEAN — `rpc_ops_snapshot().security` invariants `[]`, anon_write_holes `[]`, rls_off_base `[]`, secdef_anon `[]`. Direct catalog re-check corroborated.
- **Structural drift:** all `[]` (stalled, backward_cursor_rewinds, wmc_null, function_search_path_drift, procedure pins, cross_collection_mat_staleness, suppression_*_drift).
- **Trust health:** 1 breach = `candy_sales_stale_hours` 364.8h (known #58 Trevor-only frozen Candy book; 340.7→364.8h = +24.1h = **0 new sales**, monotonic freeze). All other reliable legs OK. `unmapped_resolution_backlog_max` 19→8 (improved). `edition_integrity_flags` 22 (flat, ok).
- **Pipeline alerts:** 5 info arms (Atlas editions 5.0% / market-feed 10.2% / supply / pack-supply 403s — all attributed Cloudflare challenge, re-asked, nothing lost; designed flow-rest-moment-moved 400). 0 critical, 0 stalled, 0 escalated.
- **Pipeline fails 24h (all `upstream:0`, self-healing):** topshot-pack-supply-atlas 264 (designed 403 re-ask); **wallet-backfill-ufc 29 = a ~40-min Flow 429 rate-limit burst (23:36→00:17Z), self-healed (last_ok 01:54Z)** — benign, UFC is a dead/revival book; atlas-market-feed 16, atlas-editions-refresh 9, candy-listings 3 (self-cleared), others ≤2.
- **Deltas:** db 41,801→**42,761 MB (+960)** — organic: `panini_card_serials` 9,031 MB dominant (Panini ingest, +107 editions today) + sales partitions / `fmv_snapshots_2026` / `topshot_atlas_market_events` append. No runaway table. FMV HIGH+MED: nba 6566→6579 (+13), panini 17712→17801 (+89), nfl 1730→1732 (+2), pinnacle 944→956 (+12), candy 74→73 (−1), golazos 1, ufc 0. editions: panini 39524→39631 (+107), rest flat. trust breaches 1→1. sentinel_ts_uuid_editions_48h 0.
- **client_error_beacon:** 0 (per 03:09Z monitor, 12h clean). **Sentry:** dark (SDK removed #34) — not health.

## Shipped
None.

## Queued — needs your decision / Claude Code
- **#HF (NEW, P3, Claude Code — hot/in-flight surface):** All Day + Panini `/[collection]/hot-floors` boards recompute a **live sessionization sweep over `sales_market`** per request (`get_allday_hot_floors` / `get_panini_hot_floors` — window funcs + HAVING count≥3, then LIMIT 50 which can't bind the scan), while the Top Shot board already reads a 15-minute snapshot (ledger 10-26 "Hot Floors reads a 15-minute snapshot"). A precompute table `allday_hot_floors_snapshot` + `refresh_allday_hot_floors_snapshot()` **already exist**, but `get_allday_hot_floors` is **not yet wired to read them**. Scan is small (2,801 All Day sales / 7d) so the two 02:34/02:36Z 8s reads (count=1, on the superseded `a33bf9e8`, degrade-to-empty) look like **first-traffic cold transients**, not a structural wall. **Ready action for CC:** wire `get_allday_hot_floors` to read `allday_hot_floors_snapshot` (as Top Shot does) and add the Panini equivalent; keep the live path as the snapshot's own refresh. **Not auto-shipped:** the board functions were committed <24h ago (`a33bf9e8`), the surface is hot and CC is actively iterating it, and the fix is a code/function change on CC's in-flight parity lane — out of the autonomous ship set. Watch for recurrence under real load.
- **#58 OPENSEA_API_KEY (carried, 32 nights, P2, Trevor):** secret rotation, no sandbox lever. Candy indexers UNSCHEDULED; `candy_sales_stale` breach is the tracked consequence (frozen book). No change.
- **Panini franchise-panel perf (carried, P2, Claude Code):** `get_panini_franchise_panel` max tail > 10s page bound; hot Panini surface. Did not recur as a new error this pass.
- **refresh_panini_offer_spread() REFRESH self-collision (carried, P3, Claude Code):** hourly refresh occasionally fails once holding a read against the MV in the same session as REFRESH CONCURRENTLY; self-heals. Fix = separate read from refresh / advisory lock.
- **panini_deal_board / panini_deal_board_all cache-warm statement-timeout (carried, watch, Claude Code):** still recurring low-count on `/api/cron/refresh-insights-cache` (last 10-27 00:07Z, count ≤2 each). Same slow-board-read family as #HF; degrades to cache. Candidate for the same precompute treatment.

## Failed / blocked / reverted
None. No verification failure; no hard-stop triggered.

## Re-check tomorrow
- hot-floors read-bound recurrence on current/next prod (watch #HF); whether CC wired All Day/Panini to the snapshot.
- candy upstream-timeout cluster recurrence (self-cleared this pass).
- db growth slope (+960 MB today; confirm panini_card_serials / sales-partition organic, not a runaway).
- #58 candy_sales_stale continues monotonic (+~24h/day, 0 sales) — unchanged expectation.
