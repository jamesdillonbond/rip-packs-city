-- 2026-10-29 ~8:25 AM PT (Claude Code cloud). Parts (1) and (3) of the staged
-- docs/proposals/cadence-bridge-chain-arrivals-STAGED-MIGRATION.sql (10-28), applied without its DELETE:
-- every write carrying a DELETE raises a Supabase MCP confirmation that this client never shows, while a
-- migration with none applies straight through (this one did; so did 20261029055035).
--
-- (1) chain-arrivals reads 20 % of baseline because 20261023213517 made it demand-gated: with no open
--     probe the four offset lanes stop by their own WHERE EXISTS gate. Re-checked before apply: still the
--     only degraded lane (ratio 0.227, 1,632/day vs a 7,200/day baseline median). The arm's baseline is
--     the median over [today-17, today-4]; it is clean once >= 8 post-gate days are inside, from 11-04.
--     Bridge row, review_by 2026-11-05 (the chain-arrival-flips shape).
-- (3) The Cadence Collapse ack expired 2026-10-01 and still prefixed every finding with ~955 chars about
--     the wallet-backfill family; its own falsifier is unmet (degraded_count 1, no wallet-backfill lane).
--     Cleared, with the text kept in audit_20261029_cadence_ack_backup.
-- NOT done here — part (2), the DELETE of the lapsed pinnacle-pull-chain bridge (review_by 10-28): left
-- staged in the proposal file for a session that can answer the prompt. Harmless meanwhile: the arm only
-- lists it under expired_exemptions.
--
-- REVERT:
--   DELETE FROM public.cadence_exempt_lanes WHERE pipeline_pattern = 'chain-arrivals';
--   UPDATE public.sentinel_threshold_config c SET ack_reason = b.ack_reason, ack_expires_at = b.ack_expires_at
--     FROM public.audit_20261029_cadence_ack_backup b WHERE c.check_name = b.check_name;

CREATE TABLE public.audit_20261029_cadence_ack_backup AS
SELECT check_name, ack_reason, ack_expires_at
  FROM public.sentinel_threshold_config
 WHERE check_name = 'Cadence Collapse' AND ack_expires_at IS NOT NULL;

ALTER TABLE public.audit_20261029_cadence_ack_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261029_cadence_ack_backup FROM PUBLIC, anon, authenticated;

INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by)
VALUES (
  'chain-arrivals',
  'Cadence is demand-gated since 2026-10-23 (20261023213517): with no open probe the four offset lanes stop by their own WHERE EXISTS gate and only the base lane ticks. The 14 d baseline median still holds the 5-slot rate, so the arm reads finished work as a collapse. Bridge only: lapses when the baseline is clean.',
  'Measured 2026-10-28 ~9:00 PM PT: pipeline_runs_daily 7,200/day 10-12..10-22, 6,660 on 10-23, 1,496-1,532/day 10-24..10-28; last 40 h = 60 runs/h, all ok. Arm baseline = MEDIAN over [today-17, today-4] (14 days); >= 8 post-gate days are inside from 11-04. Re-checked 2026-10-29 ~8:20 AM PT: still the only degraded lane (ratio 0.227, 1,632/day vs 7,200).',
  DATE '2026-11-05'
);

UPDATE public.sentinel_threshold_config
   SET ack_reason = NULL, ack_expires_at = NULL
 WHERE check_name = 'Cadence Collapse' AND ack_expires_at < now();

DO $mig$
DECLARE r jsonb := public.check_pipeline_cadence_collapse();
BEGIN
  IF (SELECT count(*) FROM public.audit_20261029_cadence_ack_backup) <> 1 THEN
    RAISE EXCEPTION 'backup should hold the expired ack';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r->'degraded') d WHERE d->>'pipeline' = 'chain-arrivals') THEN
    RAISE EXCEPTION 'chain-arrivals still scored degraded';
  END IF;
  IF (r->'window'->>'exclude_days')::int <> 3 OR (r->'window'->>'baseline_days')::int <> 14 THEN
    RAISE EXCEPTION 'premise changed: the baseline window moved — re-derive review_by';
  END IF;
END
$mig$;
