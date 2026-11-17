# Daytime monitor — 2026-10-13T15:06Z (~8:06 AM PT 10-13)

Read-only daytime sweep. Platform HEALTHY except one benign trust-health breach (below). Security 4/4 clean ([] invariants / secdef_anon / rls_off_base / anon_write_holes), stalled_pipelines [], pg_cron recent failures [], sentinel ts_uuid_editions_48h 0, ts_uuid_dupes_created_24h 0. DB 35,933 MB. Latest prod deploy: the newest commit (255bb91 "rotate 13 cron gate keys in Vault") is CANCELED — superseded by this morning's rapid gate-key/Vault push burst (Opus 5.5 sessions); the tip READY is 41375601 ("fix(overview): reads through readCollectionStatsForPage"), several siblings CANCELED (superseded builds, NO ERROR state). NOT in a saturation spell (rpc_ops_snapshot + every probe returned fast; no IO-wait majority), so the cause below is stated at normal confidence.

Candidates (sensing only):

## 1. trust-health BREACH candy_sales_stale_hours 35.7h vs 30h bound — thin-market threshold trip, indexer HEALTHY [P-low]
- **Source:** `rpc_ops_snapshot().trust_health` -> `candy_sales_stale_hours` status=BREACH, value 35.7 (breach_at 30). `trust_health_breaches: ["candy_sales_stale_hours"]`. This metric was `ok` at 3.1h on 10-11 (0307Z inbox), so it crossed the bound in the last ~2 days.
- **Attribution done this pass (not guessed):**
  - `candy-sales-indexer` (primary Magic Eden sales lane) is `ok=true` EVERY ~3h tick (12:20Z, 09:20Z, 06:40Z …), 1–2 s runs, no error.
  - `candy-listings-indexer` (same Magic Eden source, same cadence) is `ok=true` and writing real work every tick (13–25 s). So the Magic Eden connection is demonstrably alive.
  - Newest Candy card sale on record: `candy_secondary_board.max(last_sale_at)` = 2026-10-12 03:21Z → 35.8h, matching the metric exactly.
  - `candy_sales_unresolved`: 0 open, 0 rows first-seen in 48h. If fills were arriving but failing to resolve to editions they would pool here — they are not. Nothing is being dropped.
- **Risk read:** low / no data-accuracy regression. Candy MLB is a thin 1-of-1 Solana collection (125 editions, ~8,600 lifetime sales); a >30h gap between actual sales is normal for it, and the healthy indexer + empty unresolved bucket confirm there is simply nothing to capture. This is a staleness threshold tuned too tight for a low-liquidity collection, not a broken pipeline. (NOTE: the supplementary `candy-opensea-sales-indexer` 100%-fail / OPENSEA_API_KEY lane is KNOWN #58, Trevor-gated, do-not-reflag — it is NOT the cause here; it has never landed a row.)
- **Suggested action (night pass / Trevor):** confirm the reading, then either (a) make `candy_sales_stale_hours`'s breach_at volume-aware (e.g. widen to ~48–72h for Candy MLB, or suppress the arm when 48h real-sale volume is ~0 so a quiet market doesn't read as a data defect), or (b) add a one-line do-not-reflag disposition that a candy_sales_stale breach with `candy-sales-indexer` ok + `candy_sales_unresolved` empty is a quiet-market trip, not a regression. No code revert — nothing regressed.

## Already filed / tracked (NOT new — so the night pass does not double-count)
- **candy-opensea {sales,listings,offers}-indexer HIGH (100% fail, OPENSEA_API_KEY not set):** KNOWN #58, Trevor-gated, DISPOSITIONED do-not-reflag (inbox 2026-10-11T0307Z; handoff 10-11 QUEUED #4). Not re-filed.
- **suppression_count_predicate_drift topshot-misattrib-drain 877 open vs <=500:** the #101 backlog, still DRAINING (1,485 night 10-11 -> 1,198 on 10-12 -> 877 now). Resolver jobid 720 all-ok. Tracked (handoff 10-11 QUEUED #3). Not re-filed.
- **panini-collector-walk failure_rate medium ("per-walk cap of 10 min"):** by design (walkOrder rotates start collection); focus do-not-reflag.
- **atlas-editions / atlas-market / atlas-pack-supply upstream-403 (info) + flow-rest-moment-moved-400 (info) + pg_net_http_403 critical (1 call, endpoint-unknown, standing class):** by-design Cloudflare-challenge collateral / designed outcomes; all fresh (last 200 / ok drains within minutes), 0 stalled editions sets, none at escalation thresholds. topshot-pack-supply-atlas 217 fails/24h = this same by-design 403 lane.

## Sweep coverage note
- Sentry connector requires re-auth this run (unavailable) — Sentry not checked.
- Artifact validation: the live Cowork/desktop RPC artifacts cannot be enumerated or payload-validated from this cloud session (no reachable artifact-list tool), per the standing 10-11/10-12 precedent. Validated their backing data through `rpc_ops_snapshot` instead — trust_health 38 arms, fmv_by_collection all 7, editions_by_collection all 7, pack-EV arms (pack_ev_board_max_stale 0.03d, publish_shortfall 0.5%), cross_collection_mat_staleness [], public boards 0 empty / 0 slow — all present and sane, no daytime schema break from this morning's migrations.
- 1a first-tick watches (trust-health full table + cross-collection refresh verify): 15:06Z is the ~8am first PT tick; trust table read in full via snapshot (candy_sales_stale the only non-ts_uuid breach, dispositioned above); cross-collection: `cross_collection_mat_staleness []` in the snapshot (fresh, not stale).
- **inbox written to mount, push unavailable** (remote.origin.pushurl empty; no credential helper / gh reachable this session). Night pass picks this up locally.
