# atlas-market-events-prune intermittent 40P01 deadlock (NEW 2026-11-14)

**Title:** `atlas-market-events-prune` started failing with `deadlock detected` (40P01) today — 2 of 48 runs in the last 48h, both on 2026-11-14 (01:27Z and 05:27Z); zero in the prior 48h.

**Source:** `pipeline_runs` WHERE pipeline='atlas-market-events-prune' AND error ILIKE '%deadlock%' — started_at 2026-11-14 01:27:00Z, 05:27:00Z. Hourly job, 46/48 ok. Surfaced by the daytime monitor 07:09Z health sweep (recent `ok=false` scan).

**Risk read:** LOW. Harmless per run — the prune transaction rolls back and the next hourly tick re-prunes the same consumed market-event rows, so nothing accumulates. NOT stalled (`rpc_ops_snapshot` stalled_pipelines=[]; market-feed freshness fine). NOT a saturation spell (`rpc_ops_snapshot` returned normally; trust_precompute_max_age_hours 5.29, fmv_sweep_wedge_hours 0.29 — no IO-wait signal). The signal that matters is the new-today onset: it was clean for the prior 2 days, so something changed around 01:27Z.

**Suggested action (night pass):** Confirm the lock partner from the postgres log (`Process holding the lock` near 01:27Z / 05:27Z) BEFORE changing anything — do not ship from this symptom alone. Most likely partner is the Atlas market-feed INSERT writer taking the same pages/rows in a different order than the prune DELETE. If confirmed, the proven fix shape is to have the prune claim its victim rows `FOR UPDATE ... SKIP LOCKED` in a MATERIALIZED CTE and delete by key (same pattern as `resync_stuck_wmc_fmv`, 20261110), or order the DELETE by the writer's key. Also check whether an overnight migration (20261114*) touched the prune function or its source table, since onset lines up with that window. Hypothesis only — verify the partner first.
