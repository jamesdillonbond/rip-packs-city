# Handoff → Cowork: Candy trophies = MLB only, plus hourly cleanup of orphaned Candy 1/1 editions (2026-11-09 ~8:20 PM PT, Claude Code cloud)

Same route as `docs/handoff-2026-11-09-cowork-apply-staged-sql.md`: the dashboard SQL editor in Trevor's
Chrome.

## Why

- **Trevor's decision (8:00 PM PT):** "Baseball cards only" on the trophies board. DC, Bat Cowl and Palm
  Garden-style Candy collections stay off it.
- **Root fix shipped in code (`c30913392`):** a Candy 1/1 card is now its own edition, keyed by its asset
  id. The census re-keys and repoints cards over its laps. That leaves the old name-keyed 1/1 editions
  (the merged Tricons, the single Bat Cowl and Palm Garden rows, and each genuine 1/1's previous key) with
  no holder. They would sit on the board as duplicates, so an hourly cleanup removes them.

| File (fetch from `main`) | SHA-256 |
|---|---|
| `docs/proposals/candy-trophies-mlb-only-and-orphan-cleanup-STAGED.sql` | `28eb393c817b78921bf1b4014b44ef8ce4d8b3359856e1dcea9f571b95612072` |

## 1. Pre-check (stop if anything differs)

```sql
SELECT md5(pg_get_viewdef('public.v_insights_trophies'::regclass))                            AS view_md5, -- f0c5d45b6c14f45d0ca94872791d3ad3 (= 20261110034117)
       to_regprocedure('public.candy_delete_orphan_one_of_one_editions(integer)')              AS fn,       -- NULL
       (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-candy-orphan-one-of-one-editions')  AS cron;     -- 0
```

If `view_md5` differs, someone changed the view after 8:15 PM PT. This file is a full-body replace, so
send it back to Claude Code rather than overwriting their change.

## 2. Apply and record

SHA-256-check the file, paste the whole file, Run (the destructive-operation dialog is expected: the
function DELETEs). Then:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<VERSION>', 'audit_20261109_candy_trophies_mlb_only_and_orphan_one_of_one_cleanup');
```

## 3. Post-check

```sql
SELECT (SELECT count(*) FROM v_insights_trophies)                                                  AS rows,      -- ~6,930 (was 7,372)
       (SELECT reloptions FROM pg_class WHERE relname = 'v_insights_trophies')                     AS opts,      -- {security_invoker=on}
       (SELECT count(*) FROM v_insights_trophies t JOIN editions e ON e.id = t.edition_id
         JOIN candy_collections cc ON e.external_id LIKE cc.edition_prefix || ':%'
        WHERE t.collection = 'candy_mlb' AND cc.kind IS DISTINCT FROM 'mlb')                      AS non_mlb,   -- 0
       has_function_privilege('anon', 'public.candy_delete_orphan_one_of_one_editions(integer)', 'EXECUTE') AS anon_exec, -- false
       (SELECT schedule FROM cron.job WHERE jobname = 'rpc-candy-orphan-one-of-one-editions')      AS cron;      -- 22 * * * *
```

Do not run the cleanup by hand. Its first :22 tick deletes only Candy 1/1 editions that no card holds,
are older than a day, and are not referenced by any table. It reports `referenced` for any row it had
to skip.

## 4. Repo half: one command (dry-run tested: drift guard 372/372, pin PASS on Postgres, a re-run refuses)

```bash
git pull --ff-only origin main
node scripts/finish-staged-2026-11-09c.mjs <VERSION>
npx vitest run __tests__/db-invariants-drift-guard.test.ts
git rm scripts/finish-staged-2026-11-09c.mjs
```

Then the ledger entry (ledger commit first), the migrations commit, and push.

## 5. Watch

- `candy-orphan-one-of-one-editions` in `pipeline_runs` hourly: ok=true. `deleted` grows as census laps
  repoint cards; `referenced` should stay near 0.
- `v_insights_trophies` liveness: the dry run was 256 ms warm and ~88k buffers, fewer than now, since the
  non-MLB rows skip the held probe.
- The 180 merged Tricons editions: their holdings move to per-card editions as the census walks
  `2022 All-Star Tricons`.

## Revert

1. Re-apply the view from `supabase/migrations/20261110034117_audit_20261109_trophies_view_held_twice_is_not_one_of_one.sql`.
2. `SELECT cron.unschedule('rpc-candy-orphan-one-of-one-editions'); DROP FUNCTION public.candy_delete_orphan_one_of_one_editions(integer);`
   Deleted rows were unheld and unreferenced, and the census re-inserts any edition it meets again.
