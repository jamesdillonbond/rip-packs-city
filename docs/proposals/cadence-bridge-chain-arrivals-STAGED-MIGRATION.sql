-- ⚠ STAGED — NOT APPLIED. 2026-10-28 ~10:55 PM PT (Claude Code cloud).
-- apply_migration was tried four times and execute_sql once; each time the Supabase MCP approval
-- prompt went unanswered inside its 60 s window, so production is unchanged. To apply: run this
-- body through apply_migration with the name below, read the version from
-- supabase_migrations.schema_migrations, commit it as supabase/migrations/<version>_<name>.sql,
-- delete this file, and add a ledger entry.
-- ⏱ TIME-BOXED: part (1) only matters until 2026-11-04 (the baseline median is clean from then on).
-- After that date drop the chain-arrivals INSERT and keep parts (2) and (3); after 2026-11-05 the
-- DO block's first two checks still hold either way.
--
-- audit_20261029_cadence_bridge_chain_arrivals_retire_two_lapsed_suppressions
--
-- 2026-10-28 ~9:00 PM PT (Claude Code cloud; Trevor: "Keep going and do it all"). Pipeline Sentinel
-- has ended CRITICAL on every run since 10-27 2:26 PM PT. Most of it is the real Dapper outage
-- (sales ingest). Its Cadence Collapse arm carries three things that are not:
--
-- (1) chain-arrivals reads 20 % of baseline (1,438/day vs 7,200). The drop is the 10-23 change
--     20261023213517: retiring the pre-mainnet27 probes left the queue empty, so the four offset
--     lanes (rpc-chain-arrival-lane-08/23/38/53) stop by their own WHERE EXISTS gate and only the
--     base lane ticks (60/h, all ok). pipeline_runs_daily: 7,200/day 10-12..10-22, 6,660 on 10-23,
--     1,496-1,532/day 10-24..10-28. The arm's baseline is the MEDIAN over [today-17, today-4]
--     (14 days); it reaches the gated rate once >= 8 of those days are post-gate (10-24+), i.e. on
--     11-04. Bridge row, review_by 2026-11-05, the same shape as chain-arrival-flips.
-- (2) pinnacle-pull-chain's bridge lapsed 10-28 and the lane is no longer degraded (live arm output:
--     degraded = pinnacle-resolve-buyers + chain-arrivals only). The bridge did its job; the
--     lapsed row only adds an "exemption LAPSED" line to every report. Deleted.
-- (3) The Cadence Collapse ack expired 2026-10-01 and is still rendered as "[ACK EXPIRED …]" with
--     955 characters about the wallet-backfill family before every finding. Its own falsifier
--     ("degraded_count still >= 5 after this expiry with wallet-backfill baseline below 400") is
--     not met: degraded_count is 2 and no wallet-backfill lane is in it (daily totals 344-437).
--     The stale text points every reader at the wrong lanes. Cleared.
--
-- Not touched: pinnacle-resolve-buyers (ratio 0.045) is real. The Pinnacle market has had no sale
-- since 10-27 9:28 AM PT (Dapper), and since a4126e7da its no-work runs are logged, so its
-- observed count rises from here; it clears without help.
--
-- REVERT:
--   DELETE FROM public.cadence_exempt_lanes WHERE pipeline_pattern = 'chain-arrivals';
--   INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by, created_at)
--     SELECT pipeline_pattern, reason, evidence, review_by, created_at
--       FROM public.audit_20261029_cadence_suppressions_backup WHERE kind = 'exempt';
--   UPDATE public.sentinel_threshold_config c SET ack_reason = b.reason, ack_expires_at = b.ack_expires_at
--     FROM public.audit_20261029_cadence_suppressions_backup b
--    WHERE b.kind = 'ack' AND c.check_name = b.pipeline_pattern;

CREATE TABLE public.audit_20261029_cadence_suppressions_backup AS
SELECT 'exempt'::text AS kind, pipeline_pattern, reason, evidence, review_by, created_at,
       NULL::timestamptz AS ack_expires_at
  FROM public.cadence_exempt_lanes
 WHERE pipeline_pattern = 'pinnacle-pull-chain'
UNION ALL
SELECT 'ack', check_name, ack_reason, NULL, ack_expires_at::date, NULL, ack_expires_at
  FROM public.sentinel_threshold_config
 WHERE check_name = 'Cadence Collapse' AND ack_expires_at IS NOT NULL;

ALTER TABLE public.audit_20261029_cadence_suppressions_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261029_cadence_suppressions_backup FROM PUBLIC, anon, authenticated;

INSERT INTO public.cadence_exempt_lanes (pipeline_pattern, reason, evidence, review_by)
VALUES (
  'chain-arrivals',
  'Cadence is demand-gated since 2026-10-23 (20261023213517): with no open probe the four offset lanes stop by their own WHERE EXISTS gate and only the base lane ticks. The 14 d baseline median still holds the 5-slot rate, so the arm reads finished work as a collapse. Bridge only: lapses when the baseline is clean.',
  'Measured 2026-10-28 ~9:00 PM PT: pipeline_runs_daily 7,200/day 10-12..10-22, 6,660 on 10-23, 1,496-1,532/day 10-24..10-28; last 40 h = 60 runs/h, all ok (152 in the 11:00Z seed hour). Arm baseline = MEDIAN over [today-17, today-4] (14 days); >= 8 post-gate days are inside from 11-04.',
  DATE '2026-11-05'
);

DELETE FROM public.cadence_exempt_lanes
 WHERE pipeline_pattern = 'pinnacle-pull-chain' AND review_by < current_date;

UPDATE public.sentinel_threshold_config
   SET ack_reason = NULL, ack_expires_at = NULL
 WHERE check_name = 'Cadence Collapse' AND ack_expires_at < now();

DO $mig$
DECLARE r jsonb := public.check_pipeline_cadence_collapse();
BEGIN
  IF (SELECT count(*) FROM public.audit_20261029_cadence_suppressions_backup) <> 2 THEN
    RAISE EXCEPTION 'backup should hold the lapsed exemption and the expired ack';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r->'degraded') d WHERE d->>'pipeline' = 'chain-arrivals') THEN
    RAISE EXCEPTION 'chain-arrivals still scored degraded';
  END IF;
  IF jsonb_array_length(coalesce(r->'expired_exemptions', '[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION 'an expired exemption remains';
  END IF;
  IF (r->'window'->>'exclude_days')::int <> 3 OR (r->'window'->>'baseline_days')::int <> 14 THEN
    RAISE EXCEPTION 'premise changed: the baseline window moved — re-derive review_by';
  END IF;
END
$mig$;
