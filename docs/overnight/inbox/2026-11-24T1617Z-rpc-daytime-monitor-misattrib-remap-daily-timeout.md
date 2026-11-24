# Daily `rpc-topshot-misattrib-remap` timed out again — 2 of last 5 runs — UPDATE exceeding its statement_timeout at the 05:53Z slot

**Filed:** 2026-11-24 ~8:17 AM PT (rpc-daytime-monitor, read-only daytime sweep)

**Source:** `check_pgcron_recent_failures()` + `cron.job_run_details` for jobid of `rpc-topshot-misattrib-remap` (pg_cron, schedule `53 5 * * *`). Today's 05:53Z run `failed`: `ERROR: canceling statement due to statement timeout` on its `UPDATE sales s SET edition_id = t.new_edition_id, serial_number = COALESCE(t.new_serial, s.serial_number) FROM _…`. Last five daily runs: 11-20 **failed** (timeout), 11-21 ok (1 row), 11-22 ok (1 row), 11-23 ok (1 row), 11-24 **failed** (timeout).

**What:** The daily remap re-keys misattributed Top Shot sales/moments from `topshot_misattrib_onchain_map` via `remap_topshot_from_onchain_map()`. It was moved to the quietest slot (05:53Z = 9:53 PM PST) on 11-04 (`20261104163844`) precisely to dodge read-timeout pile-ups (79 s avg / 101 s max at the old slot). It is now timing out on ~40% of recent runs — the `UPDATE sales` leg is exceeding the statement timeout that reaches it through this caller.

**Blast radius (read, not guessed):** LOW and self-limiting. A skipped day leaves that day's newly-mapped misattributions un-re-keyed for ~24h until the next 05:53Z tick (historically a handful per run — the 10-10 datapoint was 14 sales + 5 moments). Not user-visible beyond a small set of edition/serial attributions lagging one day. No downstream cadence breach, no trust-health flag (snapshot trust 43/43 ok, `unmapped_resolution_backlog_max` 0/ok, `topshot_impossible_parallel_serials` 0/ok). This is NOT the #101 Atlas-resolver backlog (that is at its floor and separately tracked); it is the consumer of that map timing out.

**Risk read:** LOW. A single idempotent daily job intermittently losing a tick; the map persists and the next run re-applies the full map, so nothing is lost permanently — only delayed. Worth addressing because the failure rate is now a pattern (2 of 5), not a one-off, and the remap is a correctness lane.

**NOT a spell:** `rpc_ops_snapshot()` returned fast and IO is not saturated (no positive-control trip). The timeout is this one heavy `UPDATE`, not estate saturation.

**Suggested action (night pass / Trevor — sensing-only from here):**
1. Give the `UPDATE sales` leg inside `remap_topshot_from_onchain_map()` (or the caller `rpc-topshot-misattrib-remap`) its own longer `statement_timeout` — mirror the 120 s budget pattern already used for the heavy WMC-fossil selector (`topshot_wmc_fossil_targets`), since the slot is already the quietest and a slot move won't help a leg that simply needs longer.
2. Or batch the `UPDATE` by map chunk so no single statement runs long — the map is small, so the cost is low.
3. Verify after: the 05:53Z tick reads `succeeded` for a week, and `check_pgcron_recent_failures()` no longer lists the job.

**Context (not re-filed):** the `gha-schedule-watchdog` medium alert seen this sweep (no GHA `schedule`-tagged tick since 06:20Z, ~9.75h) is the known self-clearing #80 class already filed 2026-11-23 (`2026-11-23T1913Z-…`). Escalation trigger (two GHA-only backfills silent >24h) is NOT met: `topshot-sales-history-backfill` fresh (0.9h), `pinnacle-owner-discovery` 10.1h; sentinel pager current via its cron-job.org primary (16:04Z). No new action; no duplicate filing.
