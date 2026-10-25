# Staged: Recent-Low Totals, parts B and C (2026-10-25)

Part A (`supabase/migrations/20261025221903_…_a.sql`) is live: `recent_low_usd` plus the set and
player header totals. These two parts were **not applied**. The MCP `apply_migration` for part B
stopped on a confirmation prompt nobody answered, and no change landed.

| file | what it is |
|---|---|
| `part_b_series.sql` | migration: `get_series_detail` (live path) + `refresh_series_detail_rollup` (the rollup its fast path reads) |
| `part_c_team.sql` | migration: `get_team_detail` + `get_team_sets` (cheapest entry) |
| `test_*.sql` | the matching `supabase/tests/*.sql`, re-pinned to the new bodies (they still name the old combined migration `20261025221348_…`; change it to the applied file names) |

To land them:
1. Re-check each md5 guard against live `prosrc` (the bases are those of 2026-10-25). If a base moved, re-splice instead of applying.
2. `apply_migration` part B, then part C, each under its own name. Copy each file into `supabase/migrations/` named with the version prod records.
3. Copy the test files over `supabase/tests/`. Point their headers and the drift-guard entries (`__tests__/db-invariants-drift-guard.test.ts`) at the new files. Run the DB-invariant suite.
4. Run `select refresh_series_detail_rollup()` (or wait for jobid 357) so the series rollup rows pick up the change.
5. Delete this folder in the same commit.
