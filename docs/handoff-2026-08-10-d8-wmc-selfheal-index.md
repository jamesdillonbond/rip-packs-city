# D8 operator handoff — build the wmc `created_at` index, then activate the recent-scoped self-heal

**One operator step remains to close deep-audit D8 (the wmc-metadata self-heal).** Everything else is shipped; this is the single action that needs the Supabase **SQL editor** (not the MCP, not pg_cron — see why below).

## Why this needs the SQL editor

The self-heal fills nameless wmc rows (NULL `player_name`/`tier`/`set_name`/`mint_count`/`team_name`) from `editions`. Finding those rows requires a scan, and a full 2.2M-row scan **times out under this instance's disk-IO saturation** (measured 2026-08-10: a global sweep, a per-collection-COMMIT procedure, and even an AllDay-only scoped run all hit the 300s cap). The fix is to scope the heal to **recently-created rows** via an index on `created_at` — but building that index can't be done here:

- **MCP** wraps every statement in a transaction; `CREATE INDEX CONCURRENTLY` can't run in one.
- **pg_cron** runs jobs as `postgres` under the global **120s** `statement_timeout`, and CIC's phase-3 wait exceeds 120s under load (measured: the pg_cron build failed at 120s). Raising that cap (`ALTER ROLE postgres SET statement_timeout`) would lift the safety timeout on **every** pg_cron job mid-day — not worth the pile-up risk.
- The **SQL editor** has no statement cap, so CIC runs to completion there.

`created_at` is **insert-only**, so an index on it never disturbs HOT updates — this is the HOT-safe alternative to the `player_name IS NULL` partial index the register vetoed.

## Steps (run in the Supabase SQL editor, ideally a quiet window)

1. Build the index (a few minutes; CONCURRENTLY, so no table lock):

   ```sql
   CREATE INDEX CONCURRENTLY idx_wmc_created_at
     ON public.wallet_moments_cache (created_at);
   ```

2. Confirm it's valid:

   ```sql
   SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_wmc_created_at';   -- expect: true
   ```

3. Drain the pre-index residue once (rows older than the daily window that are still nameless), with a wide lookback — now cheap because the index exists:

   ```sql
   SELECT public.rpc_wmc_selfheal_recent(400);
   ```

4. Schedule the daily self-heal (single statement — the function takes no COMMIT, so no `SET` prefix issues):

   ```sql
   SELECT cron.schedule('rpc-wmc-metadata-selfheal-recent', '47 10 * * *',
     $$SELECT public.rpc_wmc_selfheal_recent(14)$$);
   ```

   `47 10 * * *` = 03:47 PT, a quiet UTC hour. 14-day window catches essentially all regeneration (the register measured 47,305 of 47,498 AllDay backlog rows created within 7 days).

## Verify

- After a tick, `pipeline_runs` gets a `wmc-metadata-selfheal` row with `scope='recent_14d'`, `ok=true`, and a small `rows_written` (the day's new gaps) in well under the budget.
- Then flip register D8 to RESOLVED.

## What's already shipped (no action needed)

- `rpc_wmc_selfheal_recent(int)` — the recent-scoped heal (migration `20260810162734`), anon/auth-revoked. **Inert until the index exists** (without it, it seq-scans and times out).
- `rpc_wmc_metadata_selfheal(uuid)` — a manual full-scan scoped repair tool (migration `20260810145940`); use it ad-hoc in a quiet window for a one-off per-collection heal.
- A **4,556-row UFC nameless-moment backlog** was found and healed 2026-08-10 (the 08-09 repair never covered UFC).

Revert everything: `DROP FUNCTION public.rpc_wmc_selfheal_recent(integer); DROP FUNCTION public.rpc_wmc_metadata_selfheal(uuid);` and, if built, `DROP INDEX CONCURRENTLY idx_wmc_created_at;`.
