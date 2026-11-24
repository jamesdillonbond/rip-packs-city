-- audit_20261124: Candy "Floor movers · 7 days" (Top Shot / Panini floor-movers parity; Trevor: "Do it all").
--
-- Off the daily full-state lane candy_edition_market_daily (20261026, one row per edition per PT day, floor_ask_usd =
-- candy_listing_floor.confirmed_floor_usd at 5:43 AM PT): per edition, the confirmed floor on day_now vs day_now − 7,
-- both $2+ and different. An edition with no confirmed floor on either day is left out (an ask that was not re-read
-- is not a move).
--
-- ⛔ CHANGE POINT. OpenSea asks joined the Candy book on 2026-11-23 (~10:41 PM PT, the key-free chain lane), so the
-- 11-24 lane row is the first with both venues and roughly doubled the editions carrying a floor (664 → 1,249). A
-- window whose start predates 2026-11-24 would chart the venue being ADDED, not the market. The view therefore
-- returns NO rows until day_now − 7 >= 2026-11-24 (first full window: the 2026-12-01 lane row); the board says so.
--
-- window_complete = the lane has a row on each of the 7 days in the window.
-- Measured at build: the equivalent query reads ~10k buffers in ~0.45 s (index probe per edition on the PK).
-- Refreshed daily at 13:53 UTC, 10 min after the lane (13:43 UTC); read by the Candy MLB board
-- (lib/insights/candy-board.ts, "Floor movers" tab).
--
-- Revert: SELECT cron.unschedule('candy-floor-movers'); DROP FUNCTION public.refresh_candy_floor_movers();
--         DROP MATERIALIZED VIEW public.mv_candy_floor_movers; revert the code commit.

-- anon-exec: revoked (refresh_candy_floor_movers) — new SECURITY DEFINER refresher; REVOKE FROM PUBLIC, anon, authenticated below.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_candy_floor_movers AS
WITH w AS MATERIALIZED (
  SELECT max(h.day) AS day_now, max(h.day) - 7 AS day_then FROM public.candy_edition_market_daily h
), wd AS MATERIALIZED (
  SELECT w.day_now, w.day_then,
         (SELECT count(DISTINCT h.day) FROM public.candy_edition_market_daily h
           WHERE h.day > w.day_then AND h.day <= w.day_now)::int AS lane_days
    FROM w
   WHERE w.day_then >= DATE '2026-11-24'
), mv AS (
  SELECT n.edition_id, t.floor_ask_usd AS ask_then_usd, n.floor_ask_usd AS ask_now_usd, n.listed_count AS listed_now
    FROM wd
    JOIN public.candy_edition_market_daily n ON n.day = wd.day_now
    JOIN public.candy_edition_market_daily t ON t.edition_id = n.edition_id AND t.day = wd.day_then
   WHERE n.floor_ask_usd >= 2 AND t.floor_ask_usd >= 2 AND n.floor_ask_usd <> t.floor_ask_usd
)
SELECT e.external_id::text AS external_id, e.set_id,
       e.player_name, e.name AS edition_name, (e.tier)::text AS tier, public.candy_is_rainbow(e.badges) AS is_rainbow,
       e.circulation_count,
       mv.ask_then_usd, mv.ask_now_usd, mv.listed_now,
       round(mv.ask_now_usd - mv.ask_then_usd, 2) AS change_usd,
       round((mv.ask_now_usd / mv.ask_then_usd - 1) * 100, 1) AS change_pct,
       CASE WHEN mv.ask_now_usd > mv.ask_then_usd THEN 'rise' ELSE 'fall' END AS direction,
       wd.day_then, wd.day_now, (wd.lane_days = 7) AS window_complete,
       now() AS computed_at
  FROM mv
  CROSS JOIN wd
  JOIN public.editions e ON e.id = mv.edition_id
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_candy_floor_movers_pk ON public.mv_candy_floor_movers (external_id);
CREATE INDEX IF NOT EXISTS mv_candy_floor_movers_rank ON public.mv_candy_floor_movers (direction, change_pct, external_id);

REVOKE ALL ON public.mv_candy_floor_movers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_candy_floor_movers TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_candy_floor_movers IS
  'Candy floor movers over 7 lane-days (audit_20261124): per edition, the confirmed floor on day_then vs day_now from candy_edition_market_daily, both $2+ and different. NO rows until day_then >= 2026-11-24 — OpenSea asks joined the book 11-23, so an earlier window measures the venue being added. window_complete = a lane row on all 7 days. Refreshed daily 13:53 UTC by refresh_candy_floor_movers().';

CREATE OR REPLACE FUNCTION public.refresh_candy_floor_movers()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_candy_floor_movers;
  SELECT count(*) INTO v_rows FROM public.mv_candy_floor_movers;
  PERFORM public.log_pipeline_run('candy-floor-movers', v_started, v_rows, v_rows, 0, true, NULL,
    'candy_mlb', NULL, NULL, jsonb_build_object('source', 'audit_20261124', 'window_opens', '2026-12-01'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('candy-floor-movers', v_started, 0, 0, 0, false, SQLERRM,
    'candy_mlb', NULL, NULL, jsonb_build_object('source', 'audit_20261124', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_candy_floor_movers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_candy_floor_movers() TO postgres, service_role;

REFRESH MATERIALIZED VIEW public.mv_candy_floor_movers;

SELECT cron.schedule('candy-floor-movers', '53 13 * * *', $$SELECT public.refresh_candy_floor_movers()$$);
