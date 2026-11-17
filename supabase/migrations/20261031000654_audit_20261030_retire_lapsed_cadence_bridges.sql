-- audit_20261030_retire_lapsed_cadence_bridges — 2026-10-30 (Claude Code, local, Trevor present).
-- Part (2) of docs/proposals/cadence-bridge-chain-arrivals-STAGED-MIGRATION.sql, widened: by apply time a
-- second bridge had lapsed. Both lanes read clean on the live arm (5:06 PM PT 10-30: degraded = panini-ingest
-- only; suppressed = chain-arrivals only), so each lapsed row only adds an "exemption LAPSED" line.
--   pinnacle-pull-chain  review_by 2026-10-28
--   chain-arrival-flips  review_by 2026-10-30 (baseline window now holds >= 8 post-gate days, as its evidence predicted)
--
-- REVERT:
--   INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by, created_at)
--     SELECT pipeline_pattern, reason, evidence, review_by, created_at
--       FROM public.audit_20261030_lapsed_cadence_bridges_backup;

CREATE TABLE public.audit_20261030_lapsed_cadence_bridges_backup AS
SELECT pipeline_pattern, reason, evidence, review_by, created_at
  FROM public.cadence_exempt_lanes
 WHERE pipeline_pattern IN ('pinnacle-pull-chain', 'chain-arrival-flips');

ALTER TABLE public.audit_20261030_lapsed_cadence_bridges_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261030_lapsed_cadence_bridges_backup FROM PUBLIC, anon, authenticated;

DELETE FROM public.cadence_exempt_lanes
 WHERE pipeline_pattern IN ('pinnacle-pull-chain', 'chain-arrival-flips') AND review_by < current_date;

DO $mig$
DECLARE r jsonb := public.check_pipeline_cadence_collapse();
BEGIN
  IF (SELECT count(*) FROM public.audit_20261030_lapsed_cadence_bridges_backup) <> 2 THEN
    RAISE EXCEPTION 'backup should hold both lapsed exemptions';
  END IF;
  IF jsonb_array_length(coalesce(r->'expired_exemptions', '[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION 'an expired exemption remains';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(r->'degraded', '[]'::jsonb)) d
              WHERE d->>'pipeline' IN ('pinnacle-pull-chain', 'chain-arrival-flips')) THEN
    RAISE EXCEPTION 'a retired lane reads degraded — its bridge was still load-bearing';
  END IF;
END
$mig$;
