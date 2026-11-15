# Claude Code → Cowork: apply the FMV activity-gap snapshot (SQL editor), then the repo half; and verify the first legacy-listings run

**Filed:** 2026-11-14 ~9:00 PM PT by Claude Code cloud. **Owner:** Cowork (Chrome → Supabase SQL editor; repo push). **Severity:** LOW–MEDIUM. Until it is applied, the daily data-integrity alert reports FMV coverage and the activity gap as UNKNOWN (null, unflagged); it no longer pages on the old "< 95 %" rule.
**Why Cowork:** `apply_migration` raised Supabase's destructive-statement question twice (~8:30 and ~8:45 PM PT 11-14) and both timed out unanswered, so **nothing was applied**. Verified: no `schema_migrations` row named `audit_20261114_fmv_activity_gap`. The prompt comes from the function's own retention `DELETE FROM fmv_activity_gap WHERE measured_at < now() - 14 days`. It deletes only its own snapshot rows; no user data is touched. Register: known-issues **#257**.

## What it is

The data-integrity alert changes from "overall FMV coverage < 95 %" to "editions with a recorded sale but no FMV" (Trevor, Candy FMV coverage handoff 11-14, item 4). That count is **0** on 11-14. The probe costs ~19 s cold (~760k buffers), over the route's 8 s budget, so pg_cron precomputes it 4× a day and the route (already shipped) reads the latest snapshot. A snapshot older than 26 h, or none at all, is flagged as such.

## 1. Pre-check (stop if it differs)

```sql
SELECT to_regclass('public.fmv_activity_gap');                       -- NULL
SELECT count(*) FROM cron.job WHERE jobname = 'rpc-fmv-activity-gap';  -- 0
```

## 2. Apply: paste the WHOLE `docs/proposals/fmv-activity-gap-STAGED.sql`, then the history row, as ONE run; confirm the dialog

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<UTC YYYYMMDDHHMMSS of the run>', 'audit_20261114_fmv_activity_gap');
```

## 3. Read back

```sql
SELECT public.refresh_fmv_activity_gap();            -- 6 (one row per active collection); ~20 s cold
SELECT slug, editions, fmv_editions, sold_no_fmv, generative_1of1_editions FROM public.get_fmv_activity_gap();
-- expect sold_no_fmv = 0 everywhere; candy_mlb generative_1of1_editions ≈ 10,036
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fmv_activity_gap'::regclass;   -- true
SELECT has_function_privilege('anon', 'public.get_fmv_activity_gap()', 'execute');     -- false
SELECT schedule, command FROM cron.job WHERE jobname = 'rpc-fmv-activity-gap';          -- '53 5,11,17,23 * * *'
```

## 4. Repo half (one push, ledger first)

`git mv docs/proposals/fmv-activity-gap-STAGED.sql supabase/migrations/<version>_audit_20261114_fmv_activity_gap.sql`, then run `npm run preflight` (migration parse). Add a ledger entry; the revert path is in the file header.

## 5. Also verify (read-only): the first legacy-listings runs (#257)

`b43f5ddfe` (READY by 8:40 PM PT 11-14) made the `candy-collections-market` lane also sweep legacy collections' Magic Eden asks. After the 9:47 PM PT run:

```sql
SELECT started_at AT TIME ZONE 'America/Los_Angeles', ok, extra->>'listings_written' lw, extra->>'listings_retired' lr, left(error, 200)
  FROM pipeline_runs WHERE pipeline = 'candy-collections-market' ORDER BY started_at DESC LIMIT 3;
SELECT count(*) FILTER (WHERE l.is_active) active, count(*) total
  FROM candy_listings l JOIN editions e ON e.id = l.edition_id
  JOIN candy_collections c ON c.set_id = e.set_id AND c.registry_key IS NULL AND c.kind <> 'test';
```

The falsifier: `listings_written > 0` and ok runs. If the run row lists many `listings_unresolved` in `extra.collections`, the census has not reached those mints yet. Record the number; do not write guessed editions.

## ✅ Resolution

(append here)
