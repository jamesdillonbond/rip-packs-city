# daytime monitor — morning statement-timeout cluster on three wmc/editions self-heal lanes (SYMPTOM, re-measure in a quiet window)

**Filed:** 2026-11-09 ~16:06Z by rpc-daytime-monitor (read-only daytime pass)
**Severity read:** LOW / non-urgent. Internal self-heal lanes only; nothing user-facing, no accuracy/security/deploy impact. They re-run on their own cadence and catch up. Filed so the night pass sees the full blast radius and a possible shared root.

## What was observed
Three separate in-DB jobs that each read/write `wallet_moments_cache` / `editions` all failed this morning with `canceling statement due to statement timeout` — and **each succeeded yesterday at the exact same slot**:

| job | kind | failed at | yesterday same slot |
|---|---|---|---|
| `rpc-wmc-player-names-follow-catalog-daily` (heal #221, pg_cron 834) | pg_cron | 2026-11-09 10:29Z | ok |
| `wmc-metadata-selfheal` | pipeline | 2026-11-09 10:31Z | ok (3 rows) |
| `topshot-map-atlas-reconcile` (pg_cron `47 12 * * *`) | pipeline | 2026-11-09 12:47Z | ok (83 rows) |

Source: `check_pgcron_recent_failures()` (row 1) + `pipeline_runs` (last 30h, the two `running_but_not_succeeding` rows in `rpc_ops_snapshot().pipeline_alerts`). All three errors are bare statement timeouts with **no logic error**.

## Why this is a SYMPTOM, not a diagnosis (1c discipline)
- Per Section 1c, a cluster of statement-timeout / startup-timeout failures with no logic errors is **saturation collateral, not N distinct bugs**. 10:29 and 10:31 are 2 min apart (same window); 12:47 is a second window, same shape.
- The positive control at 16:06Z read `io_wait 3 / active 8` — **NOT in a spell now**, so the 10:29–12:47 windows cannot be re-measured from this pass. Do not derive a cost or a "query too slow" conclusion from today's durations.
- The morning already had a saturation signal: inbox `2026-11-09T0412Z-daytime-monitor-saturation-spell-ripmetadata-labelfill-timeouts.md`.
- Each lane ran fine yesterday at the same slot (heal measured 2.8s / 126k buffers on 11-08; reconcile 83 rows; selfheal 3 rows), which argues transient contention over a code regression.

## Likely shared root (already queued — cross-ref)
All three contend on `wallet_moments_cache`, which is exactly the surface the 2026-11-09 overnight pass already queued: ledger 2026-11-09 entry, "candy-census `wallet_moments_cache` lock-contention" (MED, Claude Code). Today's cluster suggests the contention band is **broader than census↔label-fill** — three more daily wmc lanes land in the 10:00–13:00Z window and tip past their statement budget.

## Suggested action for the night pass (NOT a conclusion to ship)
1. In a **quiet window**, re-measure each lane's actual runtime vs the statement_timeout (EXPLAIN + timed run) to confirm whether they are genuinely near-budget or were only pushed over by morning contention.
2. If near-budget: consider giving the daily heal lanes a **row-budget / batch** the way the label-fill job got (`20261109044329`), and/or move their slots out of the 10:00–13:00Z wmc-writer band.
3. No revert anywhere — nothing shipped; these are observed symptoms.

## Blast radius if left
One missed day each: reconcile (~83 rows/day of Atlas mis-attribution repair), selfheal (~3 rows), player-name heal (#221 names following the catalog). All self-correcting on the next successful tick. Low.

## ↳ 2026-11-09 ~7:20 PM PT — merged into `2026-11-09T2211Z-…` (Claude Code cloud)

All three lanes have a fix live: the player-name heal is a cursor walk (`20261110000023`, every 5 min, 36/36 ok); the selfheal skips Candy and writes only fillable rows; job 818 has 300 s (`20261110004700`). The first overnight runs (2:31 / 4:47 AM PT 11-10) are read by the 5:05 AM PT check-in, which closes `2211Z`. Not marked resolved until then.
