-- ⚠ STAGED — PART (2) ONLY, NOT APPLIED. Updated 2026-10-29 ~8:30 AM PT (Claude Code cloud).
-- Parts (1) and (3) of the 10-28 staged migration LANDED as
-- 20261029152527_audit_20261029_cadence_bridge_chain_arrivals_clear_expired_ack (no DELETE in it, so
-- the Supabase MCP applied it without a confirmation prompt). What is left is the one DELETE, and a
-- DELETE is what raises the MCP confirmation this client never shows. Apply with someone who can
-- answer the prompt (or the dashboard SQL editor with Trevor present), commit under its version, delete
-- this file, add a ledger entry.
--
-- audit_20261029_retire_lapsed_pinnacle_pull_chain_cadence_bridge
--
-- pinnacle-pull-chain's bridge lapsed 10-28 and the lane is no longer degraded (live arm output 10-29
-- ~8:20 AM PT: degraded = chain-arrivals only, which is now bridged). The lapsed row only adds an
-- "exemption LAPSED" line to every report.
--
-- REVERT:
--   INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by, created_at)
--     SELECT pipeline_pattern, reason, evidence, review_by, created_at
--       FROM public.audit_20261029_pinnacle_pull_chain_bridge_backup;

CREATE TABLE public.audit_20261029_pinnacle_pull_chain_bridge_backup AS
SELECT pipeline_pattern, reason, evidence, review_by, created_at
  FROM public.cadence_exempt_lanes
 WHERE pipeline_pattern = 'pinnacle-pull-chain';

ALTER TABLE public.audit_20261029_pinnacle_pull_chain_bridge_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261029_pinnacle_pull_chain_bridge_backup FROM PUBLIC, anon, authenticated;

DELETE FROM public.cadence_exempt_lanes
 WHERE pipeline_pattern = 'pinnacle-pull-chain' AND review_by < current_date;

DO $mig$
DECLARE r jsonb := public.check_pipeline_cadence_collapse();
BEGIN
  IF (SELECT count(*) FROM public.audit_20261029_pinnacle_pull_chain_bridge_backup) <> 1 THEN
    RAISE EXCEPTION 'backup should hold the lapsed exemption';
  END IF;
  IF jsonb_array_length(coalesce(r->'expired_exemptions', '[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION 'an expired exemption remains';
  END IF;
END
$mig$;
