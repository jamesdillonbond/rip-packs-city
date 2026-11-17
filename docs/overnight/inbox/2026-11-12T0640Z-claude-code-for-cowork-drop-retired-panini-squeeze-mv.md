# Claude Code → Cowork: DROP the retired Panini squeeze MV in the dashboard SQL editor

**Filed:** 2026-11-11 ~10:40 PM PT by Claude Code cloud. **Owner:** Cowork (Chrome → Supabase SQL editor). **Severity:** LOW (cleanup; 2.8 MB).
**Why Cowork:** Claude Code's `apply_migration` of this DROP raised Supabase's destructive-statement question at ~1:20 PM PT 11-11 and it went unanswered (not applied, not retried). Trevor, 11-11 ~10:35 PM PT: "Hand that to cowork."

`mv_panini_squeeze_retired_20261110` was kept one day as the revert path of the 11-10 `mv_panini_squeeze` rewrite (refresh 148 s → 0.56 s). The window has passed.

## 1. Pre-check (stop if any value differs)

```sql
SELECT to_regclass('public.mv_panini_squeeze_retired_20261110')                       AS mv,          -- mv_panini_squeeze_retired_20261110
       (SELECT count(*) FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
         WHERE d.refobjid = to_regclass('public.mv_panini_squeeze_retired_20261110')
           AND r.ev_class <> to_regclass('public.mv_panini_squeeze_retired_20261110')) AS dependents, -- 0
       (SELECT count(*) FROM cron.job WHERE command ILIKE '%squeeze_retired%')          AS cron_refs,   -- 0
       (SELECT count(*) FROM pg_proc  WHERE prosrc  ILIKE '%mv_panini_squeeze_retired%') AS fn_refs;    -- 0
```

## 2. Apply (confirm the "destructive operation" dialog)

```sql
DROP MATERIALIZED VIEW public.mv_panini_squeeze_retired_20261110;
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<UTC YYYYMMDDHHMMSS of the run>', 'audit_20261111_drop_retired_panini_squeeze_mv');
```

## 3. Post-check

```sql
SELECT to_regclass('public.mv_panini_squeeze_retired_20261110') AS gone,          -- NULL
       to_regclass('public.mv_panini_squeeze')                  AS live_mv_ok;    -- mv_panini_squeeze
```

## 4. Repo half

Create `supabase/migrations/<VERSION>_audit_20261111_drop_retired_panini_squeeze_mv.sql` containing exactly:

```sql
-- audit_20261111_drop_retired_panini_squeeze_mv (applied by Cowork in the SQL editor; see inbox 2026-11-12T0640Z)
-- The 11-10 mv_panini_squeeze rewrite's one-day revert path. 0 dependents / cron / function refs; 2.8 MB.
DROP MATERIALIZED VIEW IF EXISTS public.mv_panini_squeeze_retired_20261110;
```

Ledger entry first (date · what · revert: none needed — nothing read it), then the migration file; mark this filing ✅ in INDEX.md and item 6 of `docs/handoff-2026-11-10-autonomous-afternoon-pass.md`.
