-- audit_20261025: Panini Bid vs Floor, FIRST DEFINITION — SUPERSEDED within minutes by 20261026051156
-- (audit_20261025_panini_offer_spread_floor_copy), which renamed this view to mv_panini_offer_spread_v1_unused.
--
-- Kept verbatim as applied. Its rule — the best offer on any REGULAR serial vs the edition's lowest ask, an edition
-- whose top offer sits on a special serial left off — kept only 118 of ~4,700 editions (most editions' top offer is
-- on a special), and an edition-wide best offer is not a bid on a floor copy on Panini, where offers are per serial
-- (e.g. a $300 offer on one Jokic copy against a $9 floor). The refresh function and the hourly :38 job defined here
-- are reused unchanged by the floor-copy view.
--
-- Revert: superseded; see 20261026051156.

-- anon-exec: revoked (refresh_panini_offer_spread) — new SECURITY DEFINER writer; REVOKE FROM PUBLIC, anon, authenticated below.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_panini_offer_spread AS
WITH oa AS (
  -- every serial's offer, index-only on idx_panini_serials_offer_edition
  SELECT s.edition_external_id AS external_id, max(s.best_offer_usd) AS mx, count(*)::int AS n, max(s.captured_at) AS seen
    FROM public.panini_card_serials s
   WHERE s.best_offer_usd > 0 AND s.captured_at > now() - interval '7 days'
   GROUP BY s.edition_external_id
), osp AS (
  -- special serials (#1, perfect, jersey…) only: a bid on one is not a bid on a floor copy
  SELECT s.edition_external_id AS external_id, max(s.best_offer_usd) AS mx, count(*)::int AS n
    FROM public.panini_card_serials s
   WHERE s.is_special AND s.best_offer_usd > 0 AND s.captured_at > now() - interval '7 days'
   GROUP BY s.edition_external_id
), o AS (
  -- the best offer on a REGULAR serial is exactly oa.mx whenever it beats every special's offer;
  -- an edition whose top offer is on a special (or ties one) is left off, never guessed
  SELECT oa.external_id, oa.mx AS best_offer_usd, (oa.n - coalesce(osp.n, 0)) AS serials_with_offer, oa.seen AS offer_seen_at
    FROM oa LEFT JOIN osp ON osp.external_id = oa.external_id
   WHERE osp.mx IS NULL OR oa.mx > osp.mx
)
SELECT b.external_id::text                                   AS external_id,
       b.player_name, b.set_name, b.parallel_family,
       b.circulation_count                                    AS mint_cap,
       b.thumbnail_url,
       pp.name                                                AS product_name,
       pp.last_grid_sport                                     AS sport,
       b.low_ask_usd, b.listed_count, b.ask_confirmed_at,
       o.best_offer_usd, o.serials_with_offer, o.offer_seen_at,
       round(o.best_offer_usd / b.low_ask_usd * 100, 1)       AS offer_pct_of_ask,
       round(b.low_ask_usd - o.best_offer_usd, 2)             AS spread_usd,
       b.fmv_usd,
       now()                                                  AS computed_at
  FROM public.panini_market_board b
  JOIN o ON o.external_id = b.external_id::text
  LEFT JOIN public.panini_products pp ON pp.set_id::text = split_part(substr(b.external_id::text, 10), '_', 1)
 WHERE b.low_ask_usd > 0
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_panini_offer_spread_pk ON public.mv_panini_offer_spread (external_id);
CREATE INDEX IF NOT EXISTS mv_panini_offer_spread_rank ON public.mv_panini_offer_spread (offer_pct_of_ask DESC, external_id) WHERE low_ask_usd >= 5;

REVOKE ALL ON public.mv_panini_offer_spread FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_panini_offer_spread TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_panini_offer_spread IS
  'Panini Bid vs Floor (Top Shot offer-spread parity, audit_20261025): per edition on panini_market_board, the lowest confirmed ask vs the best offer Panini shows on any REGULAR serial (is_special excluded — a bid on a #1 is not a bid on a floor copy), offers re-read in the last 7 days. An edition whose top offer sits on a special serial is left off (its regular-serial best is not known without a heap read). Panini offers are made on a specific serial, so the best offer may sit on a different copy than the cheapest listing. Refreshed hourly at :38 by refresh_panini_offer_spread().';

CREATE OR REPLACE FUNCTION public.refresh_panini_offer_spread()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_offer_spread;
  SELECT count(*) INTO v_rows FROM public.mv_panini_offer_spread;
  PERFORM public.log_pipeline_run('panini-offer-spread', v_started, v_rows, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-offer-spread', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_panini_offer_spread() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_offer_spread() TO postgres, service_role;

SELECT cron.schedule('panini-offer-spread', '38 * * * *', $$SELECT public.refresh_panini_offer_spread()$$);
