# SIXTEEN more migrations applied to production today still have no committed file — a SECOND batch, after this morning's recovery, and parity will not see it until 07:40Z tomorrow

**Filed:** 2026-08-23 ~13:30 PT (20:30Z) · **By:** Claude Code, interactive · **Status:** MEASURED. One of the seventeen is fixed (the one I needed); the other sixteen are **another session's in-flight work and are deliberately NOT touched**.

## What is true right now

`supabase_migrations.schema_migrations` carries **61 migrations applied since 2026-08-21**. Matching by NAME
against `git ls-tree HEAD supabase/migrations/` — the same identity `scripts/check-migration-parity.mjs` uses,
because `apply_migration` stamps its own version and the committed filename never matches it — **17 had no
committed file.** I committed one (below); **16 remain**:

```
audit_20260823_drop_phantom_golazos_series_2_3
audit_20260823_edition_fmv_current_comment_refreshed_at_changed_meaning
audit_20260823_edition_fmv_current_mark_and_sweep_not_probe_per_row
audit_20260823_edition_fmv_current_table_and_refresh
audit_20260823_get_series_detail_reads_existing_series_detail_rollup
audit_20260823_get_series_detail_reads_rollup
audit_20260823_get_series_detail_restore_stats_computed_at_after_concurrent_clobber
audit_20260823_get_series_editions_orders_from_edition_fmv_current
audit_20260823_get_series_editions_project_after_limit
audit_20260823_get_series_rollups_reads_edition_fmv_current
audit_20260823_get_set_editions_project_after_limit
audit_20260823_series_detail_rollup_duration_ms_never_recorded
audit_20260823_series_rollup_fmv_refresh_cannot_take_down_the_job
audit_20260823_series_rollup_refresh_drives_edition_fmv_current
audit_20260823_series_stats_rollup_fix_generated_duration_ms
audit_20260823_series_stats_rollup_table_and_refresh
```

## ⚠ This is NOT a re-file of this morning's recovery

The `Migration parity` workflow was **green every day from 08-10 through 08-22** and went **FAILURE on
2026-08-23 07:58Z**. That red was the morning batch, and it was acted on the same day
(*"eight production migrations got their git half back"*, ledger). **Fifteen of the sixteen above were applied
AFTER that recovery**, between **17:29Z and 19:28Z**, and the sixteenth (`drop_phantom_golazos_series_2_3`,
02:00Z) survived it. The guard is working; the gap simply re-opened behind it.

⚠ **And it is invisible until tomorrow.** Parity runs on a `40 7 * * *` schedule, so nothing will name these
sixteen for another eleven hours. Anyone reading a green-since-recovery badge tonight would conclude the repo
describes production. It does not.

## ⛔ Why I did not just write the sixteen files

Fifteen of them are one coherent, **still-moving** piece of work — the `series_detail_rollup` /
`edition_fmv_current` family, applied in a tight burst this evening, with at least one entry
(`..._restore_stats_computed_at_after_concurrent_clobber`) that is itself a repair of a concurrent clobber.
This repo's own coordination rule is that a session does not edit another's work from the last 24–48h, and a
migration file is not a mechanical capture: **its header carries the revert path**, and only the session that
applied it knows what it was reverting to. A file I reconstruct from `pg_get_functiondef` would record the
CURRENT state with a revert path I invented. That is worse than an absent file, because it looks authoritative.

**So this is a handoff, not a to-do I skipped.** The session that applied the `series_*` /
`edition_fmv_current` burst should commit its own sixteen files, with real revert blocks.

## What I DID fix, and why it was mine

`audit_20260823_log_pipeline_run_finished_at_uses_clock_timestamp` (applied 19:06:48Z) is the same defect in
two instruments at once: **no committed file** *and* a **stale DB-invariant pin**, which is why the daily
`DB pin staleness` sweep is red on `log_pipeline_run` right now. Re-pinning requires the file, so the file is
written — a byte-identical capture (`md5(pg_get_functiondef(...))` = `6dd327eea2dfb888e0340816dddc9fe8`,
verified against the database rather than by eye), **left UNAPPLIED** because re-applying a no-op would cost a
~10–20 s user-facing `PGRST002` burst for nothing.

⚠ **The assertion review turned up the sharper finding.** The pinned test's `finished_at > started_at`
assertion **could not see this defect in either direction**: its fixture calls the function with
`now() - interval '5 seconds'`, so it passes under the old body AND the new one. The production defect is the
opposite case — callers pass `clock_timestamp()` taken *during* the transaction, which is LATER than `now()`,
so `finished_at` landed BEFORE `started_at` and the `GREATEST`-clamped `duration_ms` was a structural zero for
ten pipelines. **A fixture that back-dates the input tests the happy direction of a defect that only shows in
the other one.** The new pin calls it the way production does and is mutation-proven to fail on the old body.

## Recommended, in order

1. **The other session commits its sixteen files** with real revert blocks. Nobody else can write those honestly.
2. ⚠ **Consider whether parity's daily cadence is enough** on a day like this one. Two independent batches
   opened and one closed inside twelve hours, and the second is unobserved for eleven more. This is a
   question about cadence, not a defect in the check — **do not "fix" it by widening the window**, which
   would drag in ~2,000 historical non-actionable rows and make the report unreadable.
3. **Re-derive before quoting any number here.** 61 applied / 17 missing / 16 remaining is a dated sample from
   20:30Z on 2026-08-23.
