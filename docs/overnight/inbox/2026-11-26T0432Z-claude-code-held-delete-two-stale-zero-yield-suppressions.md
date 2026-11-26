# Held DELETE: two stale zero-yield suppressions (Claude Code cloud, 2026-11-25 ~8:30 PM PT)

**Status: NOT APPLIED.** `apply_migration` held the DELETE for confirmation and the prompt timed out unanswered (the
cloud session was running autonomously). Read back after: both rows are still present. Nothing changed.

**Why it matters (LOW):** neither lane is flagged today, so no current Sentinel reading changes. The rows only stop
the Zero-Yield arm from seeing a future stall in two lanes that are live again. Each row's OWN re-check condition
says to remove it:

| pipeline | row claims | re-check condition (from the row) | measured 11-25 ~8:30 PM PT |
|---|---|---|---|
| `ufc-enrichment-drain` | RETIRED (10-23) | "remove this row the day ufc-enrichment-drain writes any new pipeline_runs row" | `ded424306` gave it a backstop caller (`.github/workflows/dead-lane-backstop.yml`); 3 runs in 72 h, 7:14 AM PT 11-25 wrote 114 |
| `pack-pull-source-rip-id-backfill` | DRAINED BACKLOG (10-19) | "remove this row if that population goes non-zero (extra.examined > 0)" | 144 runs / 72 h, examined 12,976, written 12,976, first write 12:11 PM PT 11-23 |

## To apply (SQL editor, or an attended `apply_migration` with this exact name)

Name: `audit_20261125_retire_two_stale_zero_yield_suppressions`

```sql
-- audit_20261125_retire_two_stale_zero_yield_suppressions
-- Two pipeline_zero_yield_suppressions rows whose own re-check conditions are met (see
-- docs/overnight/inbox/2026-11-26T0432Z-claude-code-held-delete-two-stale-zero-yield-suppressions.md).
-- REVERT: re-insert from a pre-apply SELECT of the two rows.
DELETE FROM public.pipeline_zero_yield_suppressions
 WHERE pipeline IN ('ufc-enrichment-drain', 'pack-pull-source-rip-id-backfill');
```

**Verify:** `select count(*) from pipeline_zero_yield_suppressions where pipeline in ('ufc-enrichment-drain','pack-pull-source-rip-id-backfill')` = 0,
and `check_zero_yield_lanes()->'offenders'` still `[]` (neither lane qualifies today). Commit the migration file
under the version prod assigns, and add a ledger line.
