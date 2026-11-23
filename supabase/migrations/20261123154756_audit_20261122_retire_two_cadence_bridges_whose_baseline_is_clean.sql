-- Applied 2026-11-23 ~7:48 AM PT (Cowork cloud, attended; Trevor: "work through this").
-- Inbox 2026-11-23T0200Z item 2 / 2026-11-23T1545Z item 1. Premise re-read at apply:
-- pack-pulls-chain-history 120/day vs median 120.5 (0.996), pinnacle-pack-openers 144 vs 144 (1.000); trips at 0.40.
-- Revert: INSERT INTO public.cadence_exempt_lanes SELECT * FROM public.audit_20261122_cadence_bridges_retired_backup;
CREATE TABLE IF NOT EXISTS public.audit_20261122_cadence_bridges_retired_backup AS
  SELECT * FROM public.cadence_exempt_lanes
  WHERE pipeline_pattern IN ('pack-pulls-chain-history', 'pinnacle-pack-openers');
ALTER TABLE public.audit_20261122_cadence_bridges_retired_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261122_cadence_bridges_retired_backup FROM PUBLIC, anon, authenticated;
DELETE FROM public.cadence_exempt_lanes
WHERE pipeline_pattern IN ('pack-pulls-chain-history', 'pinnacle-pack-openers') AND review_by = DATE '2026-11-23';
