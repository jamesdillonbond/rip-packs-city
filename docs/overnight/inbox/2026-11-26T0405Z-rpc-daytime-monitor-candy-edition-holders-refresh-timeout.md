# candy-edition-holders MV refresh: one statement timeout at 03:33Z (7/8 recent ticks ok; self-clears)

- **Filed by:** rpc-daytime-monitor, 2026-11-26 ~04:05Z (2026-11-25 ~8:05 PM PT)
- **Priority:** LOW
- **Source:** `check_pgcron_recent_failures()` → pg_cron `rpc-refresh-candy-edition-holders` (`33 */3`); `cron.job_run_details`.

## Observation (not a spell — positive control clean)

The MV refresh `rpc-refresh-candy-edition-holders` (`REFRESH MATERIALIZED VIEW public.mv_candy_edition_holders`, ledger line 770, normally ~11.3 s) **failed once at 2026-11-26 03:33:00Z** with `ERROR: canceling statement due to statement timeout`. The surrounding 26 h of ticks are all healthy: the prior 8 runs (00:33, 21:33, 18:33, 15:33, 12:33, 09:33, 06:33, 03:33 the day before) all `succeeded` with `REFRESH MATERIALIZED VIEW`. So **7/8 recent ok, one transient timeout.**

Positive control at read time: `pg_stat_activity` IO-wait 0 / active 0 — **not a saturation spell**, so this is a genuine transient, not saturation collateral. `rpc_ops_snapshot()` returned fast and clean. Candy trust arms all ok (candy_sales_stale 1.6 h, candy_fmv_stale 0.3 h, candy_offers_unverified 0 %).

The MV refresh is idempotent — the next tick (06:33Z) refreshes the full MV regardless, so no data is lost by the one miss; the squeeze board just read one cycle stale.

## Risk read

LOW. One miss on an idempotent, self-healing 3-hourly MV refresh; no downstream staleness past the next tick.

## Suggested action (night pass)

Re-measure, do not conclude from one run. Read `cron.job_run_details` for `rpc-refresh-candy-edition-holders` over the next ~8 ticks. If the statement timeout recurs on ≥2 of them, either (a) give the REFRESH its own `statement_timeout` headroom (it's a bare `REFRESH MATERIALIZED VIEW` under the role default, and the MV has grown — 21,510 → 21,549 keys), or (b) check what else runs at the `:33` slot that could contend (the refresh is at minute 33, off the heavy :03–:09 band). If the next ticks are clean, close as a one-off transient.

## Secondary note (info, not a finding)

`pg_net_http_404` carried `severity:high` this sweep but its body is the benign Flow historic-node probe — `"block height 74310017 is less than the spork root block height 137390146. Try to use a historic node"` — i.e. a single script querying a block below the current spork root (self-inflicted reading (b) in the alert), 1 call / 2 h, not an edge-fn auth misconfig and not an outage. Nothing lost. If the night pass wants the row to clear, record the probe's `request_id` per the alert's own instruction.
