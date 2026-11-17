-- audit_20260905: three Top Shot pipelines fire and write nothing because the work
-- they were built to do is now done elsewhere. Suppress them from
-- check_pipelines_running_but_not_succeeding(), each reason carrying a RUNNABLE
-- predicate that proves the replacement is alive. If a predicate returns false the
-- suppression is WRONG and the row must be deleted, not renewed.
--
-- anon-exec: n/a (data-only INSERT into an internal ops table; no function, no grant)
--
-- REVERT:
--   DELETE FROM public.pipeline_alert_suppression
--    WHERE pipeline IN ('topshot-catalog-backfill','ingest-topshot-challenges','topshot-misattrib-drain')
--      AND added_at >= '2026-09-05'::date;

INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at)
VALUES
(
  'topshot-catalog-backfill',
  'Redundant, not broken — the Dapper Atlas walk now keeps the Top Shot catalog current, so this backfill finds nothing to write. 3 runs / 0 rows in 30 days as of 2026-09-05. '
  || 'PREDICATE (must stay TRUE or this suppression is wrong — delete it, do not renew): '
  || 'SELECT count(*) >= 500 FROM public.editions WHERE collection_id = ''95f28a17-224a-4025-96ad-adf8a4c63bfd'' AND updated_at > now() - interval ''24 hours''; '
  || 'measured 6967 at 2026-09-05 16:28Z. If that count falls under 500 the Atlas walk has stopped maintaining the catalog and THIS pipeline is the fallback that must be un-suppressed and repaired. '
  || 'Related arm: atlas-editions-upstream-403 escalates to high when Atlas sets go stale; these two are the same fact seen from two sides.',
  now(),
  '2026-12-05 00:00:00+00'
),
(
  'ingest-topshot-challenges',
  'Redundant, not broken — the challenges table is maintained by pg_cron jobid 87 rpc-refresh-challenge-costs (schedule ''20 7 * * *''), not by this pipeline. 3 runs / 0 rows in 30 days as of 2026-09-05; all 31 challenge rows touched inside 30 days, newest updated_at 2026-09-05 07:20:00Z, which matches jobid 87''s schedule exactly. '
  || 'PREDICATE (must stay TRUE or this suppression is wrong — delete it, do not renew): '
  || 'SELECT max(updated_at) > now() - interval ''7 days'' FROM public.challenges; '
  || 'measured 2026-09-05 07:20:00Z at 2026-09-05 16:28Z. If that goes stale the user-facing /[collection]/challenges page and app/api/topshot/challenges/route.ts go stale with it, and the fix is jobid 87 — check that first, then un-suppress this pipeline only if jobid 87 is genuinely gone.',
  now(),
  '2026-12-05 00:00:00+00'
),
(
  'topshot-misattrib-drain',
  'Caught up, not broken — the drain writes 0 rows because its target set is nearly empty, and its own targets view is the measure. 3 runs / 0 rows in 30 days as of 2026-09-05, against 410 open of 20128 candidates (98.0% mapped). '
  || 'PREDICATE (must stay TRUE or this suppression is wrong — delete it, do not renew): '
  || 'SELECT count(*) <= 500 FROM public.mv_topshot_misattrib_candidates c WHERE NOT EXISTS (SELECT 1 FROM public.topshot_misattrib_onchain_map m WHERE m.nft_id = c.nft_id); '
  || 'measured 410 at 2026-09-05 16:28Z (predicate copied verbatim from topshot_misattrib_drain_targets). If the open backlog climbs past 500 the drain has stopped keeping up and this suppression must be deleted — a growing backlog means moments are being attributed to the wrong owner on collection pages.',
  now(),
  '2026-12-05 00:00:00+00'
);
