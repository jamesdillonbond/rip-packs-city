-- Applied 2026-11-23 ~7:48 AM PT (Cowork cloud, attended; Trevor: "work through this").
-- Inbox 2026-11-23T0200Z item 1. Premise re-read at apply: 1 stale row; lane wrote 1,101 rows in 7 d.
-- Revert: INSERT INTO public.pipeline_alert_suppression SELECT * FROM public.audit_20261122_ingest_topshot_challenges_suppression_backup;
DO $guard$ BEGIN
  IF (SELECT count(*) FROM public.pipeline_alert_suppression
       WHERE pipeline = 'ingest-topshot-challenges' AND reason LIKE 'Redundant, not broken%') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one stale ingest-topshot-challenges suppression row'; END IF; END $guard$;

CREATE TABLE IF NOT EXISTS public.audit_20261122_ingest_topshot_challenges_suppression_backup AS
  SELECT * FROM public.pipeline_alert_suppression WHERE pipeline = 'ingest-topshot-challenges';
ALTER TABLE public.audit_20261122_ingest_topshot_challenges_suppression_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261122_ingest_topshot_challenges_suppression_backup FROM PUBLIC, anon, authenticated;

DELETE FROM public.pipeline_alert_suppression
 WHERE pipeline = 'ingest-topshot-challenges' AND reason LIKE 'Redundant, not broken%';
