# rpc-chain-arrivals-seed newly timing out — flow_height_estimate DISTINCT over a growing puller-wallet set

**Filed:** 2026-11-10T16:07Z · daytime health monitor (read-only sweep)
**Source:** `check_pgcron_recent_failures()` → pg_cron job `rpc-chain-arrivals-seed` (`SELECT public.seed_saved_wallet_chain_arrivals();`), daily at 11:13 UTC.

## What

The 2026-11-10 11:13 UTC run of `rpc-chain-arrivals-seed` **failed** with:

```
ERROR: canceling statement due to statement timeout
CONTEXT: SQL function "flow_height_estimate" statement 1
SQL statement "WITH w AS (SELECT DISTINCT lower(trim(wallet_addr)) FROM pu…"
```

This is the **first failure** of this once-daily job — it succeeded cleanly 11-05, 11-06, 11-07, 11-08 and 11-09 (each "1 row", same 11:13:00 slot). So it is a job that just crossed its statement-timeout, not a chronic one.

## Risk read — LOW / isolated

- **Not saturation collateral.** This is a single isolated timeout on one once-daily job, not a cluster of statement/startup timeouts across many jobs. The daytime positive control taken this sweep (16:07Z) read io_wait 3 / active 4 — not a spell. (Caveat: the failure itself was at 11:13Z, five hours before that control; the cause was not measured under load.)
- **Blast radius: one day of chain-arrivals seed.** `flow_height_estimate` does a `SELECT DISTINCT lower(trim(wallet_addr))` over the puller-wallet set, which grows daily; the most likely reading is that the DISTINCT sweep crossed the job's statement_timeout as that set grew. One missed seed; the job re-fires tomorrow 11:13Z.
- Nothing is reported lost by the snapshot — this does not appear in `detect_stalled_pipelines()` (it watches `pipeline_runs`, not `cron.job_run_details`) and no `pipeline_runs` lane flags it.

## Suggested action — quiet-window RE-MEASURE, then one of two cheap levers

1. In a quiet window, `EXPLAIN (ANALYZE, BUFFERS)` the `flow_height_estimate` DISTINCT over puller wallets to measure its real cost and confirm it is the growing-DISTINCT sweep (not a transient contention hit on this one tick).
2. If it is a genuine growth wedge, the levers are (a) a supporting index / pre-aggregation for the `DISTINCT lower(trim(wallet_addr))` so it can do an index-only or grouped scan, or (b) raise this one job's `statement_timeout` via `cron.schedule` under `SET LOCAL ROLE <owner>` — it is a once-daily seed, so a longer budget is cheap. Prefer (a) if BUFFERS shows a full heap sweep.

Sensing only — not fixed. Night pass / Trevor to act.

## Resolution — 2026-11-10 ~9:05 AM PT (Claude Code cloud)

Fixed (`audit_20261110_chain_arrivals_seed_estimates_height_only_for_new_sold_moments`, recorded `20261110170308`). Re-measured first; **the filing's mechanism was a misread of the truncated CONTEXT line** — the timeout was not a `DISTINCT lower(trim(wallet_addr))` sweep (`w` is 55 wallets, 11 buffers). It fired inside `flow_height_estimate`, which the `sold` CTE called for EVERY sold (wallet, moment) group — 142,250 over 49 wallets, 44,032 with no block height, ~270 buffers / ~5 ms a call — before the exclusions dropped all but 11,658. Durations 56 s (11-03) → 104 s (11-09) → killed at the **120 s** global: the function's own `SET statement_timeout = 300s` is inert on pg_cron. Fix: exclusions first (`sold_new` MATERIALIZED), estimate only for survivors — same rows inserted; job 638's command now `SET statement_timeout = '300s'; SELECT …` (job 818 precedent). Pin `run_chain_arrival_lane.sql` +S3 (the estimate stub RAISES for an already-explained sold moment: old body red, new green); 298/298 DB-invariant files pass locally. Today's missed seed re-run via one-off pg_cron job 854. Ledger 11-10.
