# Staged: Recent-Low Totals, part B2 only (2026-10-25)

Part A (`20261025221903_…_a.sql`), part C (`20261025235754_…_c.sql`, team totals + cheapest entry) and
part B1 (`20261025235853_…_b1.sql`, `get_series_detail`'s live path) are **live**. Only **B2** is left:
`refresh_series_detail_rollup`, the rollup `get_series_detail`'s FAST path reads. Tracked as
known-issues #211.

Why it is still staged: the MCP `apply_migration` stops on a confirmation prompt for this body, every
time (3 tries on 10-25: ~3:20 PM, ~4:15 PM, ~5:00 PM PT). C and B1 went through without one, so the
trigger is the `DELETE FROM series_detail_rollup` inside it (an orphan-row cleanup, unchanged by this
change). Nothing landed on any try (md5 unchanged, no `schema_migrations` row). **Apply it with
Trevor present to answer the prompt**, or paste it into the dashboard SQL editor.

Until it lands, a series page whose rollup row exists still sums the raw floor (the live path is fixed
but only runs when no rollup row exists — i.e. almost never).

| file | what it is |
|---|---|
| `part_b2_rollup.sql` | the migration (md5 guard on the 10-25 base `0cb641fc0b801a83f786fb2935337c2a`, re-checked ~5:00 PM PT) |

To land it:
1. Re-check the md5 guard against live `prosrc`. If the base moved, re-splice.
2. `apply_migration` it; copy the file into `supabase/migrations/` under the version prod records.
3. In `supabase/tests/series_detail_pinnacle_totals.sql`, change the rollup body's non-Pinnacle
   `sum(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (...)` line to the `recent_low_usd` form
   (copy it from the migration), fix the header note, and repoint `refresh_series_detail_rollup` in
   `__tests__/db-invariants-drift-guard.test.ts` at the new file. Add a rollup assertion like test 2b
   (an out-of-band `edition_fmv_current` floor contributes FMV). Run the DB-invariant suite.
4. `select refresh_series_detail_rollup()` (or wait for jobid 357) so the rows pick up the change.
5. Delete this folder in the same commit.
