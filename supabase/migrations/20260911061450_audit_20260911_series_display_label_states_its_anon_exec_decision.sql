-- anon-exec: revoked — series_display_label is called ONLY from SECURITY DEFINER
-- readers (get_edition_detail / get_set_editions / get_series_editions), which
-- execute it as their definer, so no anon or authenticated grant is needed and
-- the default PUBLIC grant that CREATE FUNCTION hands out is removed here.
--
-- ⚠ REVOKED FROM PUBLIC, anon AND authenticated IN ONE STATEMENT. Either half
-- alone leaves a grant behind (the PUBLIC default AND ALTER DEFAULT PRIVILEGES).
-- ⚠ NO pg_cron caller is orphaned by this: the only callers are the three SECDEF
-- readers above, which run as the definer rather than as the invoking role.
-- Verified below with has_function_privilege rather than by reading acl text.
REVOKE EXECUTE ON FUNCTION public.series_display_label(uuid, int) FROM PUBLIC, anon, authenticated;

DO $do$
BEGIN
  IF has_function_privilege('anon', 'public.series_display_label(uuid, int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.series_display_label(uuid, int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'series_display_label still anon/authenticated executable after REVOKE';
  END IF;
END
$do$;

-- REVERT: GRANT EXECUTE ON FUNCTION public.series_display_label(uuid, int) TO PUBLIC;