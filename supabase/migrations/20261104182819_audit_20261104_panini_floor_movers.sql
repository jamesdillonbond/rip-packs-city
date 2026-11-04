-- audit_20261104: Panini "Floor movers · 7 days" (Top Shot parity, panini.md "Next parity candidates" (2)).
-- (Cowork scheduled task, 2026-11-04 PT.)
--
-- Off the ask-history lane panini_edition_ask_daily (20261026040131; change rows only, state on day D = newest row
-- with day <= D, NULL = left the board). Readiness read 11-04 before building: the lane logged one ok run every day
-- 10-26 .. 11-04 (10-21..10-24 are the shadow seed); 19,818 editions carry a known floor on both 10-28 and 11-04,
-- 10,019 of them at $5+ both days; 705 rose, 1,393 fell, 17,720 unchanged; 1,146 moved >= 10 % at $5+.
--
-- Per edition: the floor 7 lane-days ago vs the newest lane day, only when BOTH are $5+ and they differ.
-- Left out, and the board copy says so:
--   · editions that left the board (NULL now) — "no ask re-read in 7 days" is not a sale, so it is never a move;
--   · a RISE where a copy at or under the old floor is still marked listed but was not re-read in 7 days — the
--     board's low ask only counts re-read copies, so that rise is the cheap copy AGING OUT, not the market moving
--     (20 of 402 $5+ rises on 11-04).
-- window_complete = the lane has a row on each of the 7 days in the window; the board says so when it has not.
-- Measured at build: 1,388 rows, 0.8 s, ~11.5k buffers. Refreshed daily at 12:11 UTC (4:11 AM PST / 5:11 AM PDT),
-- 10 min after the lane; read by the hourly Panini boards snapshot (lib/insights/panini-more-boards.ts).
--
-- Revert: SELECT cron.unschedule('panini-floor-movers'); DROP FUNCTION public.refresh_panini_floor_movers();
--         DROP MATERIALIZED VIEW public.mv_panini_floor_movers; git revert the code commit.

-- anon-exec: revoked (refresh_panini_floor_movers) — new SECURITY DEFINER refresher; REVOKE FROM PUBLIC, anon, authenticated below.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_panini_floor_movers AS
WITH b AS MATERIALIZED (
  SELECT max(h.day) AS day_now FROM public.panini_edition_ask_daily h
), w AS MATERIALIZED (
  SELECT b.day_now, b.day_now - 7 AS day_then,
         (SELECT count(DISTINCT h.day) FROM public.panini_edition_ask_daily h
           WHERE h.day > b.day_now - 7 AND h.day <= b.day_now)::int AS lane_days
    FROM b
), s_then AS MATERIALIZED (
  SELECT DISTINCT ON (h.external_id) h.external_id, h.low_ask_usd
    FROM public.panini_edition_ask_daily h, w WHERE h.day <= w.day_then
   ORDER BY h.external_id, h.day DESC
), s_now AS MATERIALIZED (
  SELECT DISTINCT ON (h.external_id) h.external_id, h.low_ask_usd, h.listed_count
    FROM public.panini_edition_ask_daily h, w WHERE h.day <= w.day_now
   ORDER BY h.external_id, h.day DESC
), mv AS (
  SELECT n.external_id, t.low_ask_usd AS ask_then_usd, n.low_ask_usd AS ask_now_usd, n.listed_count AS listed_now
    FROM s_now n JOIN s_then t ON t.external_id = n.external_id
   WHERE t.low_ask_usd >= 5 AND n.low_ask_usd >= 5 AND n.low_ask_usd <> t.low_ask_usd
)
SELECT mv.external_id,
       pe.player_name, pe.set_name, pe.parallel, pe.mint_cap,
       pp.name AS product_name, pp.last_grid_sport AS sport,
       mv.ask_then_usd, mv.ask_now_usd, mv.listed_now,
       round(mv.ask_now_usd - mv.ask_then_usd, 2) AS change_usd,
       round((mv.ask_now_usd / mv.ask_then_usd - 1) * 100, 1) AS change_pct,
       CASE WHEN mv.ask_now_usd > mv.ask_then_usd THEN 'rise' ELSE 'fall' END AS direction,
       w.day_then, w.day_now, (w.lane_days = 7) AS window_complete,
       now() AS computed_at
  FROM mv
  CROSS JOIN w
  JOIN public.panini_editions pe ON pe.external_id = mv.external_id
  LEFT JOIN public.panini_products pp ON pp.set_id = pe.product_set_id
 WHERE NOT (mv.ask_now_usd > mv.ask_then_usd AND EXISTS (
         SELECT 1 FROM public.panini_card_serials cs
          WHERE cs.edition_external_id = mv.external_id AND cs.is_listed
            AND cs.price_usd > 0 AND cs.price_usd <= mv.ask_then_usd
            AND cs.captured_at <= now() - interval '7 days'))
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_panini_floor_movers_pk ON public.mv_panini_floor_movers (external_id);
CREATE INDEX IF NOT EXISTS mv_panini_floor_movers_rank ON public.mv_panini_floor_movers (direction, change_pct, external_id);

REVOKE ALL ON public.mv_panini_floor_movers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_panini_floor_movers TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_panini_floor_movers IS
  'Panini floor movers over 7 lane-days (audit_20261104): per edition, the lowest confirmed ask on day_then vs day_now from panini_edition_ask_daily, both $5+ and different. Editions that left the board are excluded (no re-read is not a sale), and so is a rise where a copy at or under the old floor is still marked listed but unconfirmed (an age-out, not a move). window_complete = a lane row on all 7 days. Refreshed daily 12:11 UTC by refresh_panini_floor_movers().';

CREATE OR REPLACE FUNCTION public.refresh_panini_floor_movers()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_floor_movers;
  SELECT count(*) INTO v_rows FROM public.mv_panini_floor_movers;
  PERFORM public.log_pipeline_run('panini-floor-movers', v_started, v_rows, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261104'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-floor-movers', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261104', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_panini_floor_movers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_floor_movers() TO postgres, service_role;

REFRESH MATERIALIZED VIEW public.mv_panini_floor_movers;

SELECT cron.schedule('panini-floor-movers', '11 12 * * *', $$SELECT public.refresh_panini_floor_movers()$$);
