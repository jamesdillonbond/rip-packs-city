-- audit_20261015_delete_topshot_misattrib_drain_suppression_its_predicate_failed
-- The row's own text: "PREDICATE (must stay TRUE or this suppression is wrong — delete it, do not renew):
-- open backlog <= 500". Measured 2026-10-15 ~1:05 PM PT from topshot_misattrib_backlog_history: open 705
-- (10-14), left_open 599 -> 362 -> 239 -> 247 -> 31/day — the Atlas resolver has reached its floor (695 of
-- the 705 answer totalCount 0 = never traded), so the predicate will stay false (ledger 10-14 NOTE).
-- It silences nothing live: the drain's watchlist row is inactive and it has not run since 09-08. Deleting it
-- ends the standing suppression_count_predicate_drift line on every ops snapshot.
-- REVERT: INSERT INTO public.pipeline_alert_suppression (pipeline, reason, added_at, expires_at)
--   VALUES ('topshot-misattrib-drain', <reason from 20260905162923 + its 2026-09-13 CORRECTION paragraph>,
--           '2026-09-05 16:29:23.202624+00', '2026-12-05 00:00:00+00');
DO $pre$
DECLARE v_open int;
BEGIN
  SELECT open_count INTO v_open FROM public.topshot_misattrib_backlog_history ORDER BY measured_on DESC LIMIT 1;
  IF v_open IS NULL OR v_open <= 500 THEN
    RAISE EXCEPTION 'precondition false: latest open backlog is %, the predicate holds — keep the row', v_open;
  END IF;
END
$pre$;

DELETE FROM public.pipeline_alert_suppression WHERE pipeline = 'topshot-misattrib-drain';

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pipeline_alert_suppression WHERE pipeline = 'topshot-misattrib-drain') THEN
    RAISE EXCEPTION 'row still present';
  END IF;
END
$post$;
