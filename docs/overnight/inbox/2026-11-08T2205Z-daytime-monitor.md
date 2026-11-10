# Daytime monitor candidates — 2026-11-08T22:05Z (≈2:05 PM PT)

Read-only daytime sweep. Platform is otherwise green: security invariants/RLS/anon-write all clean, 0 stalled pipelines, 0 pg_cron failures, sentinel TS-UUID-editions-48h = 0, 13/13 live dashboards' referenced relations+functions all exist, last production deploy READY (`e3cdc5ab` "pack calendar: every collection"; the two CANCELED builds are superseded-commit noise, no ERROR). All reads returned fast — NOT a saturation spell, so the causal reads below are safe to attribute.

Every non-green signal this run is the **Candy cluster** (all 4 trust-health breaches are Candy). One new pipeline bug, one operator re-verify, one calibration follow-on:

---

## 1. [HIGH] candy-sales-indexer: Magic Eden `/activities` rejects offset 15500 for sets `asg26` + `gold26`

- **Source:** `pipeline_runs` candy-sales-indexer, `ok=false` at `2026-11-08 21:20:13Z` — first failure after a clean run at 18:20Z (prior ~14 runs back to 11-07 all ok). Error: `later-set walk failed: asg26: ME activities HTTP 400 {"value":"15500","msg":"offset should be non-negative integer","param":"offset"} | gold26: <same>`.
- **Read:** Magic Eden caps the `/activities` offset (the walk paged to 15500 and ME 400s it as "non-negative integer" — its max-offset guard). Those two sets' later-set walk can't complete and will **recur every 3h run** while their activity depth exceeds the cap. The indexer otherwise runs; only asg26/gold26 are blocked.
- **Why it matters now:** it blocks capturing exactly the Candy **revival sales** that metric #2 is flagging — the indexer can't finish the sets where new Candy trading would land.
- **Risk:** low blast radius (2 sets), but a real logic bug that won't self-clear.
- **Suggested action (night pass):** cap the ME offset at the API max, or switch the later-set walk to ME's cursor/`before` pagination instead of a growing numeric offset, so asg26/gold26 finish.

## 2. [MED · operator decision] Candy secondary market has REVIVED — the recorded `silent_since` closure is stale

- **Source:** `v_rpc_trust_health` → `candy_revival_sales_since_recorded_silence = 3` (BREACH, breach_at 1). Partners `candy_sales_stale_hours = 655h` and `candy_ask_book_drop_pct = 95.7%` (both BREACH) are the same closure cluster.
- **Read:** the metric's own `catches` is explicit — a recorded Candy closure (`v_collection_marketplace_status.candy_mlb = silent_since_…`, recorded 2026-10-28; census said trading stopped 10-11) is now contradicted by 3 Candy sales recorded on/after the day after that date. This is the designed "page on first revival sale" signal, NOT an outage.
- **Suggested action (operator / night pass):** re-look at live Candy trading (Magic Eden `/activities` A/B) and update the `candy_mlb` row of `v_collection_marketplace_status` (`secondary_status`, `notes`, `last_verified_at`). That returns `candy_sales_stale_hours` to its 7-day backstop and clears the revival breach. A decision, not a code fix — do NOT silently flip the status without verifying.
- **Note:** fixing #1 first makes this verification trustworthy (otherwise asg26/gold26 revival sales stay invisible to the indexer).

## 3. [LOW · calibration, folds into #2] `candy_offer_spread_board` below liveness min_rows

- **Source:** `public_board_liveness_state` → `candy_offer_spread_board` row_count **17** vs watchlist min_rows **30**, `err=null`, 160ms, checked 20:28Z. This is the single `public_board_empty_count = 1` breach.
- **Read:** NOT a dark-board outage — the query runs fast and returns 17 real rows. The board thinned below its old calibration along with the 95.7% Candy ask-book collapse. The page shows real rows to users; only the liveness arm flags it.
- **Suggested action (night pass):** likely clears on its own once #2's re-verification settles the Candy market state. If the thin book is the new normal, either recalibrate `min_rows` for post-closure Candy, or carry `is_active=false` WITH a stated reason (as `candy_deals_board` already is). An INSERT/UPDATE on the watchlist, not a migration.

---

**Not findings (noted for completeness):** `candy-collections-discover` logged one `ok=false` (null error) at 21:57Z and **self-recovered** at 21:59Z — transient. The pg_net HTTP 400/403/404 `pipeline_alerts` and the atlas-*/pack-pull 24h fail counts are the known attributed-or-designed lanes (ESPN athlete-id probes 400/404, Cloudflare `Just a moment` 403 challenges with nothing lost, `panic: no nft` moved-moment 400s) — all info/attributed, none escalated.

## ✅ RESOLVED — read 2026-11-09 ~7:20 PM PT (Claude Code cloud)

(1) `candy-sales-indexer`: every run has been ok since 11-08 4:20 PM PT (the ME offset failure was the 1:20 PM PT run). (2) `candy_revival_sales_since_recorded_silence` = 0 (ok) and `candy_ask_book_drop_pct` = 16.8 (ok). `candy_sales_stale_hours` remains the known #58 closure clock (re-verify ~11-27). (3) `public_board_empty_count` is not breaching.
