# Claude Code → Cowork: drop the parked `sets_summary_prev_20261114` (Chrome → Supabase SQL editor)

**Filed:** 2026-11-14 9:07 PM PT by Claude Code cloud, on Trevor's "hand that to cowork to do in chrome" (9:06 PM PT). **Owner:** Cowork (Chrome → Supabase SQL editor, then a docs push). **Severity:** LOW. It's cleanup: 2.7 MB of storage; nothing on the site reads it.
**Why Cowork:** Trevor approved the drop ("You do it I approve", ~9:03 PM PT). But the Supabase connector's destructive-statement confirmation timed out unanswered when Claude Code called `apply_migration`, for the third time this evening, so **nothing was dropped**. No `schema_migrations` row is named `audit_20261114_drop_parked_sets_summary_prev`. Register: known-issues **#255** (the last item keeping it PARTLY RESOLVED).

## Background

At 8:57 PM PT `20261115045727` swapped `public.sets_summary` (the set pages' name-keyed read) for a corrected view whose Total Mint is complete or NULL. The DROP form had been held twice, so the old view was RENAMED aside to `sets_summary_prev_20261114` instead of dropped. Its three indexes were renamed with it (`idx_sets_summary_prev_20261114_{pk,collection,set_name}`); dropping the view drops them.

Checked before filing (~9:03 PM PT):
- 0 functions, 0 cron jobs and 0 dependent views reference it; 0 hits in the repo outside docs and migrations.
- Its scan counter stayed flat (718,378) over a 20 s sample while the live view took 213 reads.
- It is frozen at the 8:50 PM PT refresh and service_role-only.

## 1. Pre-check (stop if anything differs)

```sql
SELECT to_regclass('public.sets_summary_prev_20261114');                              -- sets_summary_prev_20261114
SELECT md5(pg_get_viewdef('public.sets_summary'::regclass));                         -- e093bda0fb7cd0bb5c21fa52a0d07952 (the corrected live view)
SELECT count(*) FROM pg_proc WHERE prosrc ILIKE '%sets_summary_prev%';               -- 0
SELECT count(*) FROM cron.job WHERE command ILIKE '%sets_summary_prev%';             -- 0
```

## 2. Apply: run as ONE statement batch and confirm the dialog

```sql
DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.sets_summary'::regclass)) <> 'e093bda0fb7cd0bb5c21fa52a0d07952' THEN
    RAISE EXCEPTION 'live sets_summary is not the corrected view -- refusing to remove the parked copy';
  END IF;
END
$guard$;
DROP MATERIALIZED VIEW public.sets_summary_prev_20261114;
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<UTC YYYYMMDDHHMMSS of the run>', 'audit_20261114_drop_parked_sets_summary_prev');
```

## 3. Read back

```sql
SELECT to_regclass('public.sets_summary_prev_20261114');                          -- NULL
SELECT count(*), count(*) FILTER (WHERE total_circulation IS NULL) FROM public.sets_summary;   -- ~3,541 / ~237 (live view untouched)
```
Also check that the next `refresh_sets_summary()` run (pg_cron 37, :50 hourly) succeeds:
`SELECT status FROM cron.job_run_details WHERE jobid = 37 ORDER BY start_time DESC LIMIT 1;` → `succeeded`.

## 4. Repo half (same session)

- Commit `supabase/migrations/<version>_audit_20261114_drop_parked_sets_summary_prev.sql` holding exactly the guard block + `DROP` from step 2 (not the history INSERT). Header: WHY (this filing), `-- REVERT: none needed; the parked copy was a stale duplicate. To recreate it, run the md5-1cfc7162 definition from 20261115045727's header note.` `migration-parity` reds until this lands.
- `docs/reference/known-issues.md` #255: change 🟠 PARTLY RESOLVED to ✅ CLOSED, replace its "Left to do" bullet with the drop's version + read-back, then `npm run -s docs:issues-index` (diff it: the only `-` line is the STATUS INDEX header).
- Ledger entry (ledger first, then the migration file).
- Mark this filing ✅ RESOLVED in place, on its INDEX.md line and in a section at the bottom. Never archive it (the inbox is append-only).

## Still open — 2026-11-15 ~7:55 AM PT (Claude Code cloud, Trevor live)

Pre-check re-run and matched every expected value (`to_regclass` present; live md5 `e093bda0…`; 0 functions / 0 cron / 0 dependent views; scan counter still 718,378; 0 repo refs outside docs/migrations). `apply_migration` with the guard + `DROP` was **refused by the session's permission classifier** (destructive action) before reaching the database, so nothing was dropped. It needs Trevor to run step 2 in the SQL editor, or to approve the drop in a session whose permissions allow it.
