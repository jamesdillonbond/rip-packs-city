# compute-golazos-pack-ev has skipped ~2–3 scheduled ticks (cadence-silent ~17.5h) while the pipeline itself is healthy every time it runs

- **When:** filed 2026-08-25 ~18:09Z by rpc-daytime-monitor.
- **Source:** `rpc_ops_snapshot()` stalled_pipelines + `check_pgcron_recent_failures()`; corroborated from `pipeline_runs`.
- **Risk read:** LOW, and NOT user-facing right now. `pack_ev_board_max_stale_days` = 0.62 (breach_at 2), `pack_ev_board_pct_depleted` = 0, `pack_ev_publish_shortfall_pct` = 0.8 — the golazos pack-EV board is fresh. Golazos is a very thin market (fmv_by_collection golazos: MEDIUM 2, LOW 87, rest STALE/NO_DATA/ASK_ONLY), so the pack-EV compute has little to move even when it does run.

## What was observed (not a causal claim)

`compute-golazos-pack-ev` was flagged cron_silent: last run 2026-08-25 **00:37:31Z**, silent **1049 min** against its 800-min watchlist threshold. The pipeline is **healthy when it fires** — the last five runs are all `ok:true` with `rows_written` 29–36:

| started_at (UTC) | ok | rows_found | rows_written |
|---|---|---|---|
| 2026-08-25 00:37 | ✓ | 40 | 36 |
| 2026-08-24 12:37 | ✓ | 40 | 29 |
| 2026-08-24 06:37 | ✓ | 40 | 34 |
| 2026-08-24 00:37 | ✓ | 40 | 33 |
| 2026-08-23 00:38 | ✓ | 40 | 29 |

The cadence is ~6h (00:37 / 06:37 / 12:37 / 18:37). Missing from the record: the **08-24 18:37** tick, and **both** of today's **06:37 and 12:37** ticks. So this is a **scheduler-skip**, not a pipeline failure — nothing is erroring, the trigger simply is not firing on some ticks.

## Why this is a SYMPTOM, re-measure before concluding

The skip pattern coincides with a saturated 24h window: `check_pgcron_recent_failures()` returned a **cluster of `statement timeout` / `job startup timeout`** failures across ~13 MV-refresh/rollup jobs, which per PRIORITY 3 + Section 1c is one disk-IO-budget root cause, not N bugs. A job that cannot get a background worker never runs and writes nothing to `pipeline_runs`, which looks exactly like this. **BUT** the daytime positive control at file time read `io_wait=2 / active=2 / total=41` — i.e. NOT in a spell at this instant — so the skip is historical, not live. Do not assert the cause from a snapshot.

## Suggested action for the night pass (re-measure, do not conclude)

1. In a quiet window, confirm what actually triggers `compute-golazos-pack-ev` (Vercel cron in `vercel.json` vs a pg_cron entry) — the sibling `compute-allday-pack-ev` and `compute-topshot-pack-ev` are worth checking in the same pass, since if this is worker-starvation it is a shared symptom, not a golazos one.
2. If it is a pg_cron job hitting `job startup timeout`, this is the known `max_worker_processes = 6` vs `cron.max_running_jobs = 32` starvation class — no golazos-specific fix, do not chase it here.
3. If it is a Vercel cron, the skip is a different question and worth a separate look.
4. Given the board is fresh and the collection is thin, this is **not urgent** and should not displace higher-value work.

Filed as a low-risk cadence observation so it is not lost, not as a diagnosis.
