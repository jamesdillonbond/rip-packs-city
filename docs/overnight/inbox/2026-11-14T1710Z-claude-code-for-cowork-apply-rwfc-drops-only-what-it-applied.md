# Claude Code → Cowork: apply the #248 fast-lane fix (SQL editor), then the repo half

**Filed:** 2026-11-14 ~9:05 AM PT by Claude Code cloud. **Owner:** Cowork (Chrome → Supabase SQL editor; repo push). **Severity:** MEDIUM. About 0.8 % of wallet rows on recently re-priced editions show a wrong portfolio value for 6–8 h.
**Why Cowork:** `apply_migration` raised Supabase's destructive-statement question twice: ~8:56 and ~9:05 AM PT 11-14. Both went unanswered within the tool's 60 s, so **nothing was applied**. Verified after each: live `md5(prosrc)` still `80f0461843d1b5105a0a3aed193eeb9d`, no `rwfc_applied` table, no `schema_migrations` row. The prompt is triggered by the function's own temp-table `DROP TABLE IF EXISTS _rwfc_recent` / `DELETE FROM _rwfc_recent`, which the live body already has. No user data is deleted. Trevor, 11-14: "Keep trying, then hand off what you need to cowork."

## What it fixes (measured 11-14 ~7:45 AM PT)

`refresh_wmc_fmv_changed` (pg_cron 303 + the `/api/wmc-fmv-populate` route) misses **1.7 % of re-priced editions**: 113 of 6,760 in a 5 % sample. That leaves **0.8 % of their wallet rows** (573 / 72,288) off the newest price until the 2-hourly backstop `resync_stuck_wmc_fmv` (min age 6 h) catches them. **72 % of the misses are one mechanism:**
1. fmv-recalc purges an edition's earlier SAME-DAY snapshot before inserting the next one (`purge_fmv_snapshots_today*`).
2. An intraday price that already reached wmc is therefore erased from history.
3. The 08-30 drop rule compares the new price with the newest pre-cursor snapshot, which is now the day-before price. When the new price equals it, the edition is dropped as "unchanged".

Example: edition `f54ee01f-6691-4865-8d8a-9f04d5365773` had 16 holder rows at 39.00 MEDIUM. Every surviving snapshot reads 17.11 LOW.

**The fix:**
- A new table, `rwfc_applied`, records what the lane last pushed per edition, and the drop rule compares against that.
- Confidence travels with the price (#248 lever (b)).
- The cursor stops 5 min behind the run start. fmv-recalc stamps its snapshots ~15 s into a ~50 s transaction, and both observed batches beat the tick by only 2–3 s.

## Staged files (in the repo, `docs/proposals/`)

- `rwfc-drops-only-what-it-applied-STAGED.sql` — the migration. It has an md5 guard on the live body, then CREATE TABLE `rwfc_applied` (RLS on, anon/authenticated revoked), a seed from `edition_fmv_current` (~70k rows), and CREATE OR REPLACE of the function. Revert path is in its header.
- `rwfc-drops-only-what-it-applied-PIN-STAGED.sql.txt` — the re-pinned `supabase/tests/refresh_wmc_fmv_changed.sql`.
  - Passed on scratch Postgres.
  - Three planted defects each red on their own assertion: the old drop rule, no confidence, and no overlap.
- `rwfc-drops-only-what-it-applied-DRIFT-GUARD-STAGED.patch` — re-points the `refresh_wmc_fmv_changed` entry's `migration:` in `__tests__/db-invariants-drift-guard.test.ts`.

## 1. Pre-check (stop if either differs)

```sql
SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_wmc_fmv_changed(integer,integer)'::regprocedure;  -- 80f0461843d1b5105a0a3aed193eeb9d
SELECT to_regclass('public.rwfc_applied');                                                                  -- NULL
```

## 2. Apply (paste the WHOLE staged file, then the history row, as ONE run; confirm the "destructive operation" dialog)

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<UTC YYYYMMDDHHMMSS of the run>', 'audit_20261114_rwfc_drops_only_what_it_applied');
```

## 3. Read back

```sql
SELECT md5(prosrc), prosrc LIKE '%rwfc_applied%' AS uses_applied, prosrc LIKE '%v_overlap%' AS has_overlap
  FROM pg_proc WHERE oid = 'public.refresh_wmc_fmv_changed(integer,integer)'::regprocedure;
SELECT count(*) FROM public.rwfc_applied;                       -- ~ count(*) FROM edition_fmv_current WHERE fmv_usd IS NOT NULL
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rwfc_applied'::regclass;   -- true
-- the next two ticks (pg_cron :x7, route every 5 min): ok, rows_written not NULL-by-error
SELECT started_at AT TIME ZONE 'America/Los_Angeles', ok, rows_written, error
  FROM pipeline_runs WHERE pipeline = 'refresh_wmc_fmv_changed' ORDER BY started_at DESC LIMIT 4;
SELECT last_cutoff AT TIME ZONE 'America/Los_Angeles' FROM rwfc_state;   -- ~5 min behind the last tick, never at it
```

## 4. Repo half (one push, ledger first)

1. `git mv docs/proposals/rwfc-drops-only-what-it-applied-STAGED.sql supabase/migrations/<version>_audit_20261114_rwfc_drops_only_what_it_applied.sql`
2. `cp docs/proposals/rwfc-drops-only-what-it-applied-PIN-STAGED.sql.txt supabase/tests/refresh_wmc_fmv_changed.sql`, then delete the `.txt`.
3. `git apply docs/proposals/rwfc-drops-only-what-it-applied-DRIFT-GUARD-STAGED.patch`, then edit the path in that entry to `<version>_…`. It is staged as `20261114160000_…`. Delete the `.patch`.
4. Run `npx vitest run __tests__/db-invariants-drift-guard.test.ts` and the pin itself (DB-invariant SQL tests in `npm run preflight`).
5. Commit the ledger entry, then push.

## 5. Watch (the pin header's pre-registered bar is DISK READS PER CALL)

Baseline: `pg_stat_statements`, 2026-11-14 7:53 → 8:55 AM PT, 62 min.

| caller | calls | buffers / call | disk reads / call |
|---|---|---|---|
| pg_cron `cron_heavy` | 6 | ~3,605 | ~15 |
| PostgREST `service_role` | 12 | ~32,300 | ~4,609 |

Use queryids `-4961185993286698538` (cron_heavy) and `-2064728835023368966` (service_role). Their t0 cumulative values are in `docs/reference/known-issues.md` #248.

- **Revert** if, in a quiet ≥ 1 h window ≥ 24 h out, reads/call exceed the 08-28 bar: 74,159 cron / 7,195 PostgREST.
- **Effect check** after ~24 h: re-run the miss sample from #248. Wallet rows on editions whose newest snapshot is 30 min–6 h old that disagree with it should fall from **0.8 % toward ~0.2 %**. The remaining ~28 % are other writers or the residual class.
- When that holds, `resync_stuck_wmc_fmv` (job 617, `33 */2 * * *`) can move to daily. Measure its 8:33 AM-style per-run reads first: 395,507 reads / 2.16M buffers on 11-14.

## ✅ RESOLVED 2026-11-14 ~9:13 AM PT (Cowork cloud via Claude in Chrome; Trevor: "I approve")

- **Pre-check passed:** live `md5(prosrc)` was `80f0461843d1b5105a0a3aed193eeb9d` and `rwfc_applied` did not exist.
- **Apply:** the staged file was fetched in the editor tab at `1f2fe3a`, SHA-256-checked (`b9ec9162…`), then loaded plus the history row and run once. Supabase's "Potential issue detected" dialog was confirmed. Applied as `20261114171317`.
- **Read back:**
  - `md5(prosrc)` = `fc41b0b8c2d75806f1bf6905e01e192c`, which equals the committed body.
  - `uses_applied` and `has_overlap` are both true.
  - `rwfc_applied` holds 68,203 rows, the same as `edition_fmv_current` priced rows.
  - RLS is on; anon has no SELECT on the table and no EXECUTE on the function.
- **Repo half:** the migration moved to `supabase/migrations/20261114171317_…`, with an anon-exec marker line added. The pin is in `supabase/tests/refresh_wmc_fmv_changed.sql`, and the drift-guard entry is re-pointed.
  - DB-invariant suite: 309 files, all PASS.
  - Migration parse: 0 errors.
  - Drift guard and anon-exec guard: green.
- **Still open:** the §5 watch (reads/call ≥ 24 h out, and the 0.8 % → ~0.2 % miss re-sample).

