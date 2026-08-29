-- APPLIED LIVE 2026-08-28 22:51:46Z from Cowork (cloud, NO-PUSH session). COMMIT ONLY — DO NOT RE-APPLY.
-- Version recorded by apply_migration: 20260828225146
--
-- Verbatim backup of the refresh-pack-grail-metrics-mv watchlist note, taken BEFORE the
-- 2026-08-28 commit-control annotation (20260828225210). Named exactly; NEVER wildcard audit_20260828_*
-- (several sessions write into that date prefix and two live revert-path backups already share it).
--
-- REVERT PATH for the annotation this backs:
--   UPDATE public.pipeline_cadence_watchlist w SET notes = b.notes
--     FROM public.audit_20260828_grail_watchlist_note_backup b
--    WHERE w.pipeline = b.pipeline;
--   DROP TABLE public.audit_20260828_grail_watchlist_note_backup;

CREATE TABLE IF NOT EXISTS public.audit_20260828_grail_watchlist_note_backup AS
SELECT pipeline, notes, now() AS backed_up_at
  FROM public.pipeline_cadence_watchlist
 WHERE pipeline = 'refresh-pack-grail-metrics-mv';

ALTER TABLE public.audit_20260828_grail_watchlist_note_backup ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.audit_20260828_grail_watchlist_note_backup FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.audit_20260828_grail_watchlist_note_backup TO postgres, service_role;

COMMENT ON TABLE public.audit_20260828_grail_watchlist_note_backup IS
  'Revert-path backup of pipeline_cadence_watchlist.notes for refresh-pack-grail-metrics-mv, taken 2026-08-28 before the commit-control annotation. Safe to drop once that annotation is accepted.';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20260828_grail_watchlist_note_backup;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 backed-up watchlist row, found %', n;
  END IF;
END $$;

-- POST-FLIGHT, verified from OUTSIDE the migration 2026-08-28 22:52Z:
--   backup_rows = 1 · backup_note_len = 115 (the pre-annotation note) · relrowsecurity = true
--   grantees = {postgres, service_role} (no anon, no authenticated)
--   check_secdef_anon_execute_violations() = []
