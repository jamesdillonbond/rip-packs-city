# allday-pack-opens-backfill `cron_silent` watchlist arm is now a false positive — the finite walk finished and the arm can no longer tell "done" from "scheduler stopped"

- **When:** 2026-08-24 ~15:07Z (daytime monitor, first-tick-of-day sweep). PT-authored.
- **Source:** `rpc_ops_snapshot()` → `stalled_pipelines` + `pipeline_alerts` flag `allday-pack-opens-backfill` as `cron_silent` (last `pipeline_runs` row 2026-08-23T21:26Z, ~17.7h silent vs its 90-min threshold). Positive control: **NOT a spell** (`pg_stat_activity` io_wait=0, active=0/41 at sweep time).
- **Risk:** LOW / hygiene. No user-facing surface, no data at risk. The concern is *instrument degradation*, not an outage.

## What's actually happening
The pg_cron job (`rpc-allday-pack-opens-backfill`, jobid 55, `6,16,26,36,46,56 * * * *`) **IS firing and succeeding** — verified directly in `cron.job_run_details`: `status=succeeded, "1 row"` at 15:06, 14:56, 14:46, 14:36, 14:26Z (and continuously). `j.active=true`.

So the walk is healthy; it has simply reached `done:true`. The watchlist note itself predicted the floor would be hit ~2026-08-14 (SPORK_FLOOR raised to the mainnet24 root; pre-2023-11-08 AllDay opens are a permanent, disclosed coverage limit). Once `done:true`, the finite walk **stops writing a `pipeline_runs` row**, while pg_cron keeps ticking every 10 min.

## Why this is a finding and not just noise
The arm's own note says to KEEP THE ROW ACTIVE even after `done:true`, on the reasoning that *"the pg_cron job keeps firing, so silence here still means the SCHEDULER stopped, which is a real signal. Retire only if job 55 is unscheduled."* That reasoning no longer holds: the scheduler is **firing and succeeding** yet the pipeline is **silent**, so the arm now conflates "done-and-healthy" with "scheduler-stopped" — exactly the CLAUDE.md class *"a permanently-silent instrument is indistinguishable from a broken one at a glance."* It will re-raise on every sweep from here forward, training the reader to ignore it (and masking a genuine scheduler stop if one ever occurs).

## Suggested action (night pass / Trevor — do NOT act from this read)
Confirm the walk logged `done:true` (its last real `pipeline_runs` payload before it went silent), then make the arm done-aware rather than presence-of-run-aware: e.g. suppress `cron_silent` for this pipeline while `cron.job` jobid 55 `active=true` AND its last run `status=succeeded`, OR re-point the arm to watch `cron.job_run_details` for jobid 55 (scheduler liveness) instead of `pipeline_runs` (work liveness). Either restores the "scheduler stopped is a real signal" property the note wants without the standing false positive. This is a watchlist/telemetry tweak (a migration), shippable without a git push.

## Not re-filed (already tracked, confirmed still-open this sweep)
- Cross-collection `rpc-ccm-step2` stale (`cross_collection_ts_set_overlap_mat` last refreshed 2026-08-22 20:43Z; step2 failed again 2026-08-23 23:25Z on statement timeout while step1 succeeds) → **already ESCALATED** in `inbox/2026-08-21T2340Z-ESCALATION-the-cross-collection-mats-have-failed-every-day-since-08-18.md`.
- `public_board_empty_count` / `public_board_slow_count` both read 999 (sentinel) → board-watchdog batch-loss fragility, `inbox/2026-08-24T0225Z-the-board-watchdog-loses-every-probe-it-completed-when-any-one-times-out.md` (nightly de-escalated to hygiene).
- `fmv_sweep_wedge_hours` 5.98 BREACH → fmv-recalc saturation class (R46 / disk-IO budget), owned.
- `unmapped_resolution_backlog_max` 350 BREACH → owned honest-finding; the arm's own catches text says DO NOT raise `breach_at`.
- pg_cron statement/startup-timeout cluster (rpc-atlas-pack-ev, refresh-new-collectors, ccm-step2, thin-sale-ask-disclosure, refresh-challenge-costs, etc.) → saturation collateral, one root (SMALL-instance disk-IO budget), focus.md item 3: do not open new investigations.
