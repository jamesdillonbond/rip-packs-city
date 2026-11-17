# Overnight pass — 2026-11-16 (~1:11 AM PT)

Genuine overnight run (clock verified vs DB: shell/VM 09:02Z · DB now() 09:03Z · newest sale ingest 08:54Z · newest FMV 08:53Z — no skew). Push AVAILABLE (laptop-VM route, dry-run exit 0). Not frozen. Lock was RELEASED (prior overnight-pass d730bea7, pushed a1196b7c5); taken over as `a3920f188190`.

**Verdict: QUIET GREEN. 0 shipped, 0 reverted.** Every live inbox candidate was already resolved by the 11-15 Claude Code sessions, or is owned by another scheduled task, or is a read-only product decision for Trevor. Post-ship watch on the last 24–48h of ships is CLEAN. Nothing was both safe and not-already-done to ship.

## What was reviewed

- **Inbox drained — 6 filings since the 11-15 pass (09:12Z):**
  - `2026-11-15T1604Z` candy_sales_unresolved backlog — Candidate 1 **already DONE** 11-15 2:18 PM PT (arm redesign `20261115221844`); Candidate 2 (hybrid_custody) handled by the 90s-timeout fix `20261115172736`. No action.
  - `2026-11-15T2311Z` pack_ev_history thinning — **already RESOLVED** 11-15 5:55 PM PT (`20261116014326`). Post-ship watch below.
  - `2026-11-16T0058Z` wallet-search cache-first — **already RESOLVED** 11-15 6:00 PM PT + names decided 10:08 PM PT. No action.
  - `2026-11-16T0404Z` candy merged multi-mint editions (#259) — **already ACTED ON** 11-15 8:41 PM PT (`79c7bcece` + `20261116043431`). Post-ship watch below.
  - `2026-11-16T0410Z` candy_secondary_board liveness slow — **one-off flicker, no action** (see Health).
  - `2026-11-16T0705Z` daytime monitor — 2 candidates, both QUEUED (see below).
- **Dashboards:** none flagged broken; the 07:05Z monitor validated 13/13 live dashboard queries' objects. Not touched.
- **Post-ship regression watch (last 24–48h ships):** CLEAN — see below.

## Section 2 — health-drift findings + deltas

**GREEN.** Security 4/4 `[]` (invariants, anon_write_holes, rls_off_base, secdef_anon all clean). stalled_pipelines `[]`. sentinel TS-48h 0. ts_uuid_dupes_24h 0. wmc_null_edition_key `[]`. cross_collection_mat_staleness `[]`. edition_integrity_flags 8 (ok, breach_at 250).

**Trust breaches: 1** (was 2 last pass) — `candy_sales_stale_hours` 38.7 h, breach_at 0. Known Candy wind-down / backfill-parking churn; composition now 2,269 `queued_collections_walk`/untried (the class the 11-15 redesign excludes) + **130 `edition_not_ingested`** (attempts>1, actively retried) + 1 `unresolvable_serial`. The 130 edition_not_ingested rows are the leg still tripping the >50-in-48h arm. Candy market closed since 10-11 → no user impact. `public_board_slow_count` recovered 1→0.

**pipeline_fails_24h — all upstream:0, all chronic/known:** topshot-pack-supply-atlas 36, atlas-pack-market 21, atlas-market-feed 8, pack-nft-identity 7 (chronic Atlas Cloudflare challenge lanes — attributed, fresh 200s landing, nothing lost); refresh_wmc_fmv_changed 3 (QUEUED, #248); hybrid_custody_backfill 2 (both predate the 90s fix); + singles. pipeline_alerts: hybrid_custody medium (pre-fix pooled) + the chronic Atlas info rows (all attributed, 0 catalog staleness).

**Vercel:** prod `a1378127b` (giveaways internal-account guard) READY. HEAD `f5001849` is the 07:05Z docs-only inbox commit — correctly CANCELED by ignoreCommand (no rebuild). No ERROR deploys. 24h runtime errors: 4 groups, all count 1–2, all chronic graceful-degradation (Panini/Parallel premiums 8s read-exceeded degrading to empty; candy player top-collectors timeout → degrading to empty; pack-detail 5s). No new crash class. (Sentry dark since 08-18 #34; GREEN rests on the Vercel error groups being chronic/bounded + the client_error beacon 1/24h.)

**Deltas vs 11-15 metrics-latest.json:**
- db_size_mb 52,838 → 53,881 (+1,043). net._http_response heap 11 MB + TOAST 3,410 MB (large HTTP response bodies), live 8,388, **dead_tup 0, autovacuumed 08:41Z** — healthy, not a leak. (⚠ The prior "677 MB" note was NOT `pg_total_relation_size`; do not read 677→3,421 as a jump — different size function. Going forward record heap + toast split.)
- FMV HIGH+MED (05:35Z computed): nba 7,010→7,026 (H 1,547 / M 5,479); panini 20,347→20,428 (H 2,286 / M 18,142); nfl 1,774→1,784 (H 305 / M 1,479); pinnacle 988→991 (H 244 / M 747). candy now MEDIUM 2 (was 0). golazos MED 1. ufc STALE 582 / NO_DATA 43 (market closed).
- editions: candy 21,472→21,568 (+96); panini 47,238→47,674 (+436); ufc 617→625 (+8); nba/nfl/golazos flat.
- edition_integrity_flags 8→8. trust_precompute 5.29 h fresh.

## Post-ship regression watch — CLEAN

- **pack_ev_history thin (`20261116014326`, one-off + daily job 889):** one-off deleted 691,464 rows (1.41M→723k) at 11-15 5:51 PM PT, ok. Job 73 (`refresh_mv_pack_ev_latest`, every 30 min) durations over 26 h: 18.9–34.9 s, mostly 24–28 s — consistent with the pre-thin 26.6–34.9 s (modest improvement as the resolution note predicted; the matview refresh is not dominated by the history scan alone). `pack_ev_publish_shortfall_pct` 0.49 unchanged. **Daily job 889 has NOT fired yet** — first run ~5:01 AM PT 11-16 (expect a heartbeat + completion row, rows_written low tens of thousands). No regression.
- **#259 candy multi-mint re-key (`79c7bcece`/`20261116043431`):** over-circulation cards 3,857 (filing) → **2,400**, merged editions 90 → **63**, draining toward 0 as the census re-reads each card from its own metadata. On track. No regression. (Close #259 when the re-measure SQL reads 0 — inbox `2026-11-16T0404Z`.)
- **candy_sales arm redesign (`20261115221844`):** working for its targeted class — the 2,269 untried `queued_collections_walk` rows no longer count. Residual breach is a DIFFERENT leg (130 `edition_not_ingested`), not a regression of the ship. See QUEUED C2.
- **hybrid_custody 90s timeout (`20261115172736`):** the 2 recent fails (11-15 10:23Z, 10:33Z) BOTH predate the 17:27Z fix; last run 11-15 13:19Z ok. First post-fix run ~11-16 1:19 PM PT will tell whether 90s is enough. Not yet exercised.
- **candy_secondary_board liveness (0410Z):** the 15,642 ms reading was a ONE-OFF — probe ticks 20:28Z 2,145 ms, 00:28Z 15,642 ms, **06:28Z 886 ms**; `public_board_slow_count` now 0. Not persistent → no index/re-baseline. Resolved by observation.

## SHIPPED

None.

## QUEUED (owned elsewhere or needs Trevor)

1. **`refresh_wmc_fmv_changed` new statement-timeout class (#248, 0705Z C1) — OWNED by the #248 close-out.** New fail class since the 11-14 fast-lane apply (`20261114171317`); 0 before, ~3/day (~2% of 144 ticks), each a single 30-s timeout. **Data impact LOW** — the lane re-reads a 5-min overlap behind its cursor every 10 min (a timed-out tick is re-covered next tick) and the hourly `resync_stuck_wmc_fmv` backstops. The suggested lever (narrow the overlap window or index the `rwfc_applied` join, NOT raise statement_timeout) is a route-logic/FMV decision — off-limits for the night pass. The #248 close-out read is already scheduled 11-16 10:20 AM PT (`trig_01CScx2oshq9AXFGxvLJEeiZ`) and will read this lane + job 617's first daily run (4:33 AM PT). Folded into that watch. **Not auto-reverted** (focus-file rule: a #248 fail means "write the numbers into #248", not revert; the fast-lane pair is net-negative IO).
2. **`candy_sales_stale_hours` edition_not_ingested carve-out (0705Z C2) — needs Trevor.** 130 `edition_not_ingested` Candy sales (attempts>1, actively retried, last 06:20Z) trip the >50-parked-in-48h "indexer unhealthy" arm the 11-15 redesign left in place for non-backfill reasons. On a market closed since 10-11, these are historical sales awaiting edition ingestion, not a live-capture failure. Question for Trevor: is a permanently-lit arm acceptable here, or does the arm want an `edition_not_ingested`-aware carve-out like the backfill one? **Read-only — do NOT edit the view** (per the filing). Known-class, not urgent.

Still queued from prior nights (gated / needs Trevor):
- fmv-activity-gap step 6 (ME-file diff — Project-only + gated) and step 7 (OpenSea Solana program-id research, #256). (2 nights.)
  - ↳ **11-16 10:35 AM PT (Claude Code, laptop): this line was STALE when written.** Step 6 DONE 11-15 ~8:20 AM PT (2,529 parked; the queue has since drained to 0 open rows). Step 7 answered 11-15: no official page publishes the program id (OpenSea hands it out per order as `protocol_address`), so #256 waits on Trevor's sourcing call, not on research. See inbox `2026-11-15T0500Z` resolution.
- ↳ Items 1–2 above: **CLOSED 11-16** — #248 resolved by the 10:20 AM PT close-out; the Candy arm reads `ok` at 10:34 AM PT (`7c437d4da` resolved the rows).

Resolved since last pass (removed from queue): **#255 drop parked `sets_summary_prev_20261114`** — the table no longer exists (`to_regclass` NULL); dropped 11-15. No longer queued.

## FAILED / AUTO-REVERTED

None.

---
Lock `a3920f188190` released at end of run. Metrics → `docs/overnight/metrics-latest.json`. Ledger entry appended.
