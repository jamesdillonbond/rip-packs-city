-- audit_20261123: Panini ROOKIE CARDS board — mv_panini_rookie_board (2026-11-23 night, Panini parity pass 3; Trevor:
-- "Do it all").
--
-- Top Shot and All Day have rookie boards (/insights/rookies, /insights/rookie-board): per player, the rookie
-- editions, their market and 30-day activity. Panini marks rookie cards per SERIAL (panini_card_serials.nft_type
-- contains "rookie card", read from Panini's own card data; 14,353 editions across ~1,900 players on 11-23, every
-- sport Panini sells). This board is the per-player read of those editions:
--   rc_editions / rc_products   editions flagged rookie card (any serial) and the products they are in;
--   fmv_total_usd               sum of edition_fmv_current over the PRICED rookie editions (priced_editions says how
--                               many; an unpriced edition is counted, never summed as $0);
--   cheapest_ask_usd            lowest ask re-confirmed in the last 7 days (the market board's rule), with its edition;
--   sales_30d / volume_30d_usd  sales ON RECORD sold in the last 30 days (they reach RPC days late — the board says so);
--   top_*                       the highest-FMV rookie edition, for the row's link and art.
-- sport = the product sport most of the player's rookie editions are in.
-- Cost: ~163k buffers / 2.8 s (measured 11-23; the rookie partial index + 7-day asks + 30-day sales), so a materialized view,
-- refreshed daily at 4:21 AM PST (12:21 UTC — a minute no other Panini lane uses) by refresh_panini_rookie_board(),
-- which logs pipeline 'panini-rookie-board' with ok derived from the refresh.
-- Revert: SELECT cron.unschedule('panini-rookie-board'); DROP FUNCTION public.refresh_panini_rookie_board();
--         DROP MATERIALIZED VIEW public.mv_panini_rookie_board;

CREATE MATERIALIZED VIEW public.mv_panini_rookie_board AS
WITH rk AS (
  SELECT DISTINCT s.edition_external_id AS ext
    FROM public.panini_card_serials s
   WHERE s.nft_type LIKE '%rookie card%'
), ed AS (
  SELECT rk.ext, btrim(pe.player_name) AS player_name, pe.product_set_id, pe.set_name, pe.mint_cap,
         pr.last_grid_sport AS sport, e.thumbnail_url,
         CASE WHEN f.fmv_usd > 0 THEN f.fmv_usd END AS fmv_usd
    FROM rk
    JOIN public.panini_editions pe ON pe.external_id = rk.ext
    JOIN public.editions e ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid AND e.external_id = rk.ext
    LEFT JOIN public.panini_products pr ON pr.set_id = pe.product_set_id
    LEFT JOIN public.edition_fmv_current f ON f.edition_id = e.id
   WHERE nullif(btrim(pe.player_name), '') IS NOT NULL
), asks AS (
  SELECT s.edition_external_id AS ext, min(s.price_usd) AS ask
    FROM public.panini_card_serials s
    JOIN rk ON rk.ext = s.edition_external_id
   WHERE s.is_listed AND s.price_usd > 0 AND s.captured_at > now() - interval '7 days'
   GROUP BY 1
), sl AS (
  SELECT ps.edition_external_id AS ext, count(*)::int AS n, sum(ps.amount_usd) AS v, max(ps.sold_at) AS newest
    FROM public.panini_sales ps
    JOIN rk ON rk.ext = ps.edition_external_id
   WHERE ps.sold_at > now() - interval '30 days' AND ps.amount_usd > 0
   GROUP BY 1
), j AS (
  SELECT ed.*, a.ask, sl.n, sl.v, sl.newest FROM ed LEFT JOIN asks a ON a.ext = ed.ext LEFT JOIN sl ON sl.ext = ed.ext
), sp AS (
  SELECT DISTINCT ON (player_name) player_name, sport
    FROM (SELECT player_name, sport, count(*) AS c FROM ed WHERE sport IS NOT NULL GROUP BY 1, 2) z
   ORDER BY player_name, c DESC, sport
)
SELECT j.player_name,
       (array_agg(sp.sport))[1] AS sport,
       count(*)::int AS rc_editions,
       count(DISTINCT j.product_set_id)::int AS rc_products,
       count(j.fmv_usd)::int AS priced_editions,
       round(sum(j.fmv_usd), 2) AS fmv_total_usd,
       min(j.ask) AS cheapest_ask_usd,
       (array_agg(j.ext ORDER BY j.ask ASC NULLS LAST, j.ext) FILTER (WHERE j.ask IS NOT NULL))[1] AS cheapest_ask_external_id,
       COALESCE(sum(j.n), 0)::int AS sales_30d,
       COALESCE(round(sum(j.v), 2), 0) AS volume_30d_usd,
       max(j.newest) AS newest_sale_at,
       (array_agg(j.ext ORDER BY j.fmv_usd DESC NULLS LAST, j.ext))[1] AS top_external_id,
       (array_agg(j.set_name ORDER BY j.fmv_usd DESC NULLS LAST, j.ext))[1] AS top_set_name,
       (array_agg(j.fmv_usd ORDER BY j.fmv_usd DESC NULLS LAST, j.ext))[1] AS top_fmv_usd,
       (array_agg(j.thumbnail_url ORDER BY j.fmv_usd DESC NULLS LAST, j.ext))[1] AS top_thumbnail_url,
       now() AS computed_at
  FROM j
  LEFT JOIN sp ON sp.player_name = j.player_name
 GROUP BY j.player_name;

CREATE UNIQUE INDEX mv_panini_rookie_board_pk ON public.mv_panini_rookie_board (player_name);
CREATE INDEX mv_panini_rookie_board_volume ON public.mv_panini_rookie_board (volume_30d_usd DESC, player_name);

REVOKE ALL ON public.mv_panini_rookie_board FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_panini_rookie_board TO service_role;

-- anon-exec: revoked (refresh_panini_rookie_board) — writer; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.refresh_panini_rookie_board()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_rookie_board;
  SELECT count(*) INTO v_rows FROM public.mv_panini_rookie_board;
  PERFORM public.log_pipeline_run('panini-rookie-board', v_started, v_rows, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261123'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-rookie-board', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261123', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_panini_rookie_board() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_rookie_board() TO service_role;

SELECT cron.schedule('panini-rookie-board', '21 12 * * *', 'SELECT public.refresh_panini_rookie_board()');

COMMENT ON MATERIALIZED VIEW public.mv_panini_rookie_board IS
  'Panini rookie cards per player (2026-11-23): editions flagged rookie card (panini_card_serials.nft_type), FMV total of the priced ones, cheapest 7-day confirmed ask, 30-day sales on record, top edition. Daily 12:21 UTC via refresh_panini_rookie_board().';
