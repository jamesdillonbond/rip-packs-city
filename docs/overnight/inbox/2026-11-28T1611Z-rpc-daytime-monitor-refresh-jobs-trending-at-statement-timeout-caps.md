# Three heavy refresh jobs trending at / over their statement_timeout caps (120 s)

Source: rpc-daytime-monitor sweep, 2026-11-28 ~8:11 AM PT (16:11Z). `check_pgcron_recent_failures()` + `pipeline_runs` + `cron.job_run_details`. Positive control at 8:05 AM PT read io_wait 1 / active 2 — NOT a saturation spell, so these are interpretable, but each individual timeout happened in an earlier window whose load I cannot retroactively verify — treat every causal/"quiet" claim below as pending a quiet-window re-measure (Section 1c discipline).

Common class: three growing MV/board refreshes are each creeping into their 120 s statement_timeout as the warehouse grows. All three are fail-soft (a failed refresh keeps the prior copy; trust-health FMV/holder staleness arms were all ok at sweep time, e.g. `candy_fmv_stale_hours` 0.3), so there is no current user-facing gap — but the trend will turn into recurring stale copies if the caps are not moved/raised or the queries not scoped. None are on the Declined list; none already in today's inbox.

---

## 1. `rpc-refresh-candy-edition-holders` MV refresh — RE-MEASURE the focus re-open condition (MEDIUM)
- Source: `check_pgcron_recent_failures()` (2/8 failed) + `cron.job_run_details`. Last 24 h durations climbed across the day as the candy-editions MV grows (21,535 candy editions): 03:33Z 27 s → 06:33Z 56 s → 09:33Z 83 s → 12:33Z 96 s → **15:33Z (7:33 AM PT) TIMEOUT at 120 s**. Second failure 00:33Z (4:33 PM PT) is the known busy-afternoon window focus already accounts for.
- Risk: LOW user impact now (fail-soft keeps the prior MV; candy holder/FMV staleness arms ok). The focus steer marked this item CLOSED with the explicit re-open trigger "re-open only if a quiet-window refresh times out." The 7:33 AM PT timeout *may* satisfy that — but 7:33 AM PT overlapped an active `panini-collector-walk` burst, so it is not a verified-quiet window.
- Suggested action (night pass, quiet window): re-measure one refresh in a provably quiet minute; if it still exceeds ~120 s, move the job off its `:33` slot to a quieter start minute and/or raise its statement_timeout / scope the REFRESH. Do NOT act on the 7:33 AM reading alone.

## 2. `rpc-topshot-moment-id-editions` daily job at its 120 s cap (LOW-MEDIUM)
- Source: `check_pgcron_recent_failures()` + `cron.job_run_details`. Daily ~2:23 AM PT (10:23Z). **11-28 10:23Z TIMEOUT at 120 s** building `CREATE TEMP TABLE _tmie …`; the prior run (11-27 10:23Z) succeeded at **101.5 s** — i.e. it is sitting right at the cap and one tick missed. 1 fail / 1 run in window.
- Risk: LOW — single missed tick; next run retries tomorrow ~2:23 AM PT; no stalled-pipeline or trust-health signal.
- Suggested action (night pass): confirm the next run's duration; if it stays ≥ ~100 s, scope the `_tmie` build (the min(ext) over moment_id union) or raise the cap. Re-measure before acting.

## 3. `panini-rookie-board` refresh timed out, 0 rows this cycle (LOW)
- Source: `rpc_ops_snapshot()` pipeline_alerts "running_but_not_succeeding" + `pipeline_runs`. Its single run in 26 h — **12:21Z (4:21 AM PT) — went `ok=false`, rows_written 0, `canceling statement due to statement timeout`.** The board was not refreshed this cycle (serves its prior copy).
- Risk: LOW — infrequent board; fail-soft. Worth watching only if it keeps missing cycles.
- Suggested action (night pass): check the board's refresh cadence and the next run; if it times out repeatedly, scope/optimize the board query. Re-measure before acting.

---
Non-findings confirmed this run (not logged, for the record): the `rpc_ops_snapshot()` baseline momentarily reported `public_board_empty_count`/`public_board_slow_count` = 999/BREACH at 16:06Z, but a direct `v_rpc_trust_health` read and an immediate re-run both returned 0/ok — a transient caught during the ~15-min public-board precompute window (and the trophies slow-board that arm last caught was itself fixed this morning by `20261128153925`). `candy-wallet-refresh` 5/6-failed alert is the known 11-26 ~125k-card whale QA (no runs since). `panini-collector-walk` 25 "fails"/24 h are per-walk time-budget partial sweeps that still write rows (productive, known shape).
