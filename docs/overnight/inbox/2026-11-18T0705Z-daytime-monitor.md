# Daytime health monitor — 2026-11-18 ~07:05Z

Read-only sweep. No saturation spell (`pg_stat_activity` io_wait 0, active 1). Security all `[]` (0 RLS-off base tables, 0 anon write holes, 0 secdef-anon violations, invariants `[]`). Dashboards 13/13 backing objects present (no schema change this window). Last prod deploy `3705da73` READY, no ERROR deploys. One trust breach this tick (candy, below); the pack-nft-identity ON CONFLICT bug filed at 0110Z has escalated.

## HIGH — candy-sales-indexer aborting on later-set walks (asg26 / quest26 / ball24 timeouts) → `candy_sales_stale_hours` now BREACH
- **Source:** `pipeline_runs` `candy-sales-indexer` — last 3 runs (00:20Z, 03:20Z, 06:20Z 11-18) `ok=false` `rows_written=0`, error `later-set walk failed: asg26 … | quest26 … | ball24: The operation was aborted due to timeout`. Last completed run 2026-11-17 21:20Z (ok, 0 rows); last run that wrote a row 2026-11-17 09:20Z. `rpc_ops_snapshot` `running_but_not_succeeding` = **high**.
- **Effect:** `v_rpc_trust_health.candy_sales_stale_hours` = 29.5h, status **BREACH** (breach_at 0). The metric is indexer-health-aware (per its `catches` text): with the indexer healthy it uses the recorded-closure clock (~674–730h) and sits `ok`; three consecutive failed walks flipped breach_at to 0, so **the breach IS the indexer-down signal, not a Candy market event**. Both earlier ticks today (01:10Z, 04:08Z) read 0 trust breaches — NEW this window.
- **Risk read:** MED–LOW blast radius (Candy is a recorded closure trading in trickles; `candy_revival_sales_since_recorded_silence` = 3, floor 10, ok), but it is a genuine trust BREACH and the Candy fresh-ingest / FMV-freshness path is down. `upstream` column = 0, but the error is an upstream (Magic Eden / Candy source) **timeout** on specific later sets, not an RPC exception.
- **Suggested action (night pass):** isolate the later-set walk so one slow set (asg26 All-Star ICONs / quest26 Collection Quest / ball24) can't abort the whole run — per-set try/commit, a smaller page, or a longer per-set budget — so a healthy set still lands and the stale clock clears. **Re-measure first:** a single transient upstream-slow window clears on the next 3-hourly tick; three in a row on the same named sets is the signal it won't.

## HIGH (escalation of the 0110Z MED filing) — `pack-nft-identity-lane` now failing EVERY 5-min tick
- **Source:** `check_pgcron_recent_failures()` / `cron.job_run_details` — job `rpc-pack-nft-identity-lane`, `ON CONFLICT DO UPDATE command cannot affect row a second time`, now **77 failed of 288** runs in window (was 5/288 at 01:10Z); every tick 06:28Z→07:03Z failed. `detect_stalled_pipelines()` / snapshot: pipeline `pack-nft-identity` last ok **2026-11-18 00:58Z** (~6h with no successful identity resolution).
- **Already filed** `2026-11-18T0110Z-daytime-monitor.md` with the root-cause fix (de-duplicate proposed rows / `DISTINCT ON` the conflict key before `INSERT … ON CONFLICT`). This note only raises its priority: the batch now contains a duplicate conflict-key row on essentially every run, so the lane has been fully stalled since ~00:58Z. No data loss (a failed statement writes nothing; rows re-offered next tick), but identity resolution is not advancing. Night pass: **same fix, now HIGH.**

## Known / no new action
- **Dapper Studio GraphQL 530** (since ~4:23 PM PT 11-17) — covers the whole pack-ingest `running_but_not_succeeding` cluster (allday / golazos / pinnacle / topshot pack-sales + opens, AD pack-EV) and the upstream-attributed pack-sales `fails_24h`. Documented focus steer; by design these WARN. Not re-filed.
- **allday-pack-dist-totals** null `total_opened` (MED) — filed `2026-11-18T0408Z`. Not re-filed.
- **panini-team-walk** 33.3% (`page 113: no readable products`) — retry-ordering fix shipped 11-17; the 11-18 ~3:35 AM PT walk is the watch (focus.md). Not a finding.
- **Atlas `edge_fn_http_error` info rows** (403/404 on editions / market / pack-supply / ask-book / on-demand lanes) — designed Cloudflare-challenge behavior, recent last-200s (07:04Z), none at escalation threshold.
- **Sentry** dark since 08-18 (#34) — not health.

## ✅ RESOLVED 11-18 (candy indexer cleared by itself, isolation already existed; pack-nft-identity applied)

Candy later-set timeouts cleared by themselves and the per-set isolation already existed (ledger 11-18, item B: non-fix). `candy_sales_stale_hours` read 4.9 h / ok on 2026-11-19 ~9:30 PM PT. The pack-nft-identity half was applied 11-18 ~7:13 AM PT. Marked by the 2026-11-19 Cowork cloud audit pass; no change made for this filing by that pass.
