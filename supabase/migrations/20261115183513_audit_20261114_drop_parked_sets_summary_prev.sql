-- 2026-11-14 (PT) — known-issues #255: remove the parked pre-fix copy of sets_summary.
-- 20261115045727 swapped public.sets_summary for the corrected view (Total Mint complete
-- or NULL) and RENAMED the old one aside to sets_summary_prev_20261114 because the DROP
-- form was held by the connector's confirmation. Nothing reads it (0 functions, 0 cron
-- jobs, 0 dependent views, 0 repo refs outside docs/migrations; scan counter flat).
-- Applied 2026-11-15 ~10:35 AM PT by Cowork through the Supabase SQL editor (Trevor
-- approved: "You do it I approve"); filing docs/overnight/inbox/2026-11-15T0506Z-….
-- The schema_migrations history row was inserted in the same editor run.
-- REVERT: none needed; the parked copy was a stale duplicate. To recreate it, run the
-- md5-1cfc7162 definition from 20261115045727's header note.

DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.sets_summary'::regclass)) <> 'e093bda0fb7cd0bb5c21fa52a0d07952' THEN
    RAISE EXCEPTION 'live sets_summary is not the corrected view -- refusing to remove the parked copy';
  END IF;
END
$guard$;
DROP MATERIALIZED VIEW public.sets_summary_prev_20261114;
