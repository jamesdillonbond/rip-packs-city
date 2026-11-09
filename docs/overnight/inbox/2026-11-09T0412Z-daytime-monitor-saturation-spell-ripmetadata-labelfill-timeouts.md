# Daytime monitor — 2026-11-09 04:12Z (8:12 PM PT 11-08): saturation spell, statement-timeout collateral on backfill-pack-rip-metadata + rpc-candy-wmc-label-fill

**⚠ SYMPTOM observed under saturation — re-measure in a quiet window before acting. Do NOT assert a cause from anything in this filing.**

## Positive control (Section 1c)
`pg_stat_activity` at 04:06Z: **io_wait=15, active=15 — 100% of active sessions in IO wait.** This is a confirmed saturation spell. Every duration/completion read below is therefore uninterpretable; this filing records what was observed, not why.

## What was observed
- **`backfill-pack-rip-metadata`** (pipeline, cron-job.org :53): 6 consecutive `canceling statement due to statement timeout` runs, 0 rows each, 22:53Z -> 03:53Z. Last success 21:53Z (361 rows). Snapshot's `running_but_not_succeeding` arm flags it (0 ok / 0 rows in 120 min). It is NOT in `detect_stalled_pipelines` (that arm reads max(started_at) with no ok filter, so the failing runs keep its silence clock green).
- **`rpc-candy-wmc-label-fill`** (pg_cron, every 4 min, shipped 11-08): `check_pgcron_recent_failures()` lists it — `statement timeout` on its `UPDATE wallet_moments_cache ... SET tier=COALESCE(...)` step, 6 failed runs in the last 2h, last fail 04:07Z. pg_cron blast radius is otherwise clean (this is the only failing pg_cron job).
- Both failures are `statement timeout` with **no logic errors** — the saturation-collateral signature (Section 1c: "a cluster of statement timeout / job startup timeout failures with no logic errors is saturation collateral, not N distinct bugs").

## Why this is new (not already filed)
- The 5 trust-health breaches are already filed (edition_integrity at 01:05Z; the 4 Candy-closure breaches at 22:05Z) — not re-raised here.
- The 11-08 "Candy collections census moves :43 -> :57" ledger entry was the *fix* for rip-metadata timing out on the census collision. rip-metadata is **still** timing out at :53 (6h), post-fix. During the spell the cause cannot be asserted (census still brushing it vs. pure saturation vs. something else), so this is logged as an open symptom, not a regression verdict.

## Suggested action (quiet-window RE-MEASURE — NOT a causal conclusion)
For the night pass / Trevor, once the spell clears (re-check the positive control first):
1. Re-measure whether `backfill-pack-rip-metadata` recovers on its own once IO pressure drops. If it still times out in a quiet window, the 11-08 census-slot move did not clear its slot — re-measure the actual overlap of the census walk vs the :53 rip-metadata run (per-call pgss blocks/call, not wall-clock), and whether rip-metadata's own query needs a cost cut.
2. `rpc-candy-wmc-label-fill` is self-unscheduling *when its cursor is done*. If it times out every run during saturation it makes no forward progress, so the cursor never reaches done and the job never retires — re-measure its per-step cost in a quiet window and consider a smaller `p_keys` step size (it was sized live at 150 keys = 8,050 rows in 9.4s under light load; under tonight's pressure even that times out). This also keeps the Candy wmc label NULLs (and, downstream, edition_integrity_flags) from draining.
3. Confirm whether the spell itself is driven by the overnight Candy label-fill + census + registry load landing together — **re-measure, do not assert.**

Source: `rpc_ops_snapshot()` pipeline_alerts (running_but_not_succeeding); `pipeline_runs` WHERE pipeline='backfill-pack-rip-metadata'; `check_pgcron_recent_failures()`; `pg_stat_activity` positive control. All read 2026-11-09 04:06-04:12Z.
Risk: read-only observation; no action taken. The night pass owns any fix.
