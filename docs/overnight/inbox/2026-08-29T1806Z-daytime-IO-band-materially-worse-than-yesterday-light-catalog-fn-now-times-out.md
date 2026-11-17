# Daytime monitor — 2026-08-29 ~18:06Z (11:06 PT)

Read-only sweep. Platform is up; security clean (0 RLS-off public tables); latest production deploy
(`8085035`, e2e reporter fix) is READY with no ERROR deploys. Lock RELEASED by the 10:46 PT night pass,
so this write is unblocked. One genuinely-new observation (a severity escalation of the known daytime
IO band); everything else is documented / already inboxed and is NOT re-filed.

## SYMPTOM (quiet-window re-measure — do NOT act on the cause under saturation, per SKILL Section 1c)

**The daytime IO band is materially MORE severe at this tick than the same tick yesterday, and it has
crossed a new threshold: a LIGHT catalog function now times out, not just the heavy snapshot.**

- Positive control, 2026-08-29 18:06Z: `pg_stat_activity` **io_wait=40, active=41 of 51 sessions**
  (a majority of active sessions in IO wait → confirmed IN a spell). Compare the identical tick
  yesterday (inbox `2026-08-28T1810Z`): **io_wait=9, active=8 of 36** — today is ~4–5× the IO-wait
  session count.
- **`rpc_ops_snapshot()` timed out** (`57014`, statement 1) — same as yesterday.
- **NEW vs yesterday:** `check_pgcron_recent_failures()` — a *light* `cron.job_run_details` catalog
  function — **also timed out** (`57014`). Yesterday every light indexed read returned FAST in the same
  window; today they do not. A light catalog read timing out is a worse band than "the heavy FMV
  sentinel times out."
- Active-query snapshot at 18:06Z (observation, NOT a cause — a constant hourly structure cannot be the
  cause of a swinging spell, per SKILL 1c): a concurrent band of `REFRESH MATERIALIZED VIEW CONCURRENTLY
  mv_topshot_p*` (8m53s old) + `mv_topshot_m*`, `refresh_mv_pack_ev_latest()` (5m53s), plus
  `refresh_wmc_fmv_changed(30,200000)`, `roll_pack_ask_hourly_low()`, and an autovacuum
  `VACUUM ANALYZE wallet_moments_cache` (15m17s). 14 `COMMIT`s queued on the WALWrite LWLock; ~10
  PostgREST reads stalled on `DataFileRead`.
- Risk read: LOW/informational for now — this is saturation collateral of the documented ~01:00–19:00Z
  disk-IO band (known-issues #27 / IO-bound, not CPU-bound), not a systemic outage and not a broken
  function. But the escalation matters: two consecutive days at the same 18:06Z tick show the band
  intensifying, and the monitor's own baseline instruments (`rpc_ops_snapshot`, now even a light
  catalog fn) are unusable inside it, so the sweep must fall back to isolated single-object reads (which
  is what this run did).
- Suggested action (quiet window, ~20:00–00:00Z or overnight, per SKILL 1c): re-run `rpc_ops_snapshot()`
  and `check_pgcron_recent_failures()` OUTSIDE the band to confirm both are healthy when uncontended
  (expected). Separately, a ≥several-day distribution of the 18:00Z-tick `io_wait/active` ratio would
  show whether this is a trend or a single bad hour — an 8-run or 2-day tail cannot decide that. Symptom
  observed under saturation — re-measure in a quiet window before acting; do not derive a cost or a fix
  from anything read during the spell.

## Context for the night pass — NOT new findings, recorded so they are not re-diagnosed

- **Artifact validation (SKILL 1b) DEFERRED this run** — running ~12 heavy jsonb payload queries during
  this (worse-than-usual) IO band would stack IO and time out uninterpretably. No artifact is flagged
  broken. Re-validate on a quiet-window tick.
- **First-tick-of-day extras (SKILL 1a) SKIPPED** — this is the ~11 PT tick, not the ~8am first tick.
- **pg_cron failures / stalled pipelines NOT enumerated** — both deterministic checks
  (`check_pgcron_recent_failures`, `detect_stalled_pipelines`) are unreadable inside this band; their
  timeouts are spell collateral, not findings. The known cluster (board/market-MV 600s timeouts #27,
  the Top Shot legacy-endpoint outage already inboxed 08-28/08-29, sync-nba-projections #8, candy-editions
  killed ~45%) is unchanged and not re-raised.
