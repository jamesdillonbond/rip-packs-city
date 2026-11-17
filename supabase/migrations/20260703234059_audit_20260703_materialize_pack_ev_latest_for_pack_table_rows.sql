-- Bug 3: /api/packs (pack_table_rows) 500s at ~31.7s — over service_role's 30s
-- statement_timeout. Root cause: pack_table_rows LEFT JOINs pack_ev_latest, a
-- plain view that re-derives DISTINCT ON (pack_listing_id) over the full ~113k-row
-- pack_ev_history on EVERY request (~10-20s cold, ~113k heap fetches to apply the
-- pack_ev/pack_price/pack_name filter). pack_ev_history is append-only snapshots,
-- so "latest per listing" only changes when the pack-EV pipeline writes a new snap.
--
-- Fix: precompute that latest-per-listing set once in a materialized view and point
-- ONLY pack_table_rows at it (pack_ev_latest keeps its 9 other dependents untouched).
-- Values are IDENTICAL to the view — no EV math changed, just cached — refreshed
-- every 10 min by pg_cron (CONCURRENTLY, mirroring refresh_pack_grail_metrics_mv).
CREATE MATERIALIZED VIEW public.mv_pack_ev_latest AS
  SELECT DISTINCT ON (pack_listing_id)
    pack_listing_id, collection_id, dist_id, pack_name, pack_price, gross_ev,
    pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count,
    total_unopened, depletion_pct, snapshotted_at, primary_price, secondary_ask,
    price_source, primary_available, secondary_available
  FROM pack_ev_history
  WHERE pack_ev >= (-10000)::numeric AND pack_ev <= 1000000::numeric
    AND pack_price > 0::numeric AND pack_name NOT LIKE 'Holding %'::text
  ORDER BY pack_listing_id, snapshotted_at DESC
WITH DATA;

CREATE UNIQUE INDEX mv_pack_ev_latest_pack_listing_id_uidx
  ON public.mv_pack_ev_latest (pack_listing_id);
CREATE INDEX mv_pack_ev_latest_dist_coll_idx
  ON public.mv_pack_ev_latest (dist_id, collection_id);

REVOKE ALL ON public.mv_pack_ev_latest FROM PUBLIC;
GRANT SELECT ON public.mv_pack_ev_latest TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_mv_pack_ev_latest()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  SET statement_timeout TO '120s'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_pack_ev_latest;
END;
$function$;
REVOKE ALL ON FUNCTION public.refresh_mv_pack_ev_latest() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refresh_mv_pack_ev_latest() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_mv_pack_ev_latest() TO service_role;

CREATE OR REPLACE VIEW public.pack_table_rows AS
 SELECT pd.dist_id,
    pd.collection_id,
    c.name AS collection_name,
        CASE
            WHEN c.name::text = 'NBA Top Shot'::text THEN 'nba-top-shot'::text
            WHEN c.name::text = 'NFL All Day'::text THEN 'nfl-all-day'::text
            WHEN c.name::text = 'LaLiga Golazos'::text THEN 'la-liga-golazos'::text
            WHEN c.name::text = 'UFC Strike'::text THEN 'ufc-strike'::text
            ELSE lower(replace(c.name::text, ' '::text, '-'::text))
        END AS collection_slug,
    COALESCE(pd.title, pd.metadata ->> 'name'::text) AS title,
    COALESCE(pd.metadata ->> 'thumbnail'::text, pd.image_url) AS image_url,
    pd.nft_type,
    lower(pd.metadata ->> 'tier'::text) AS tier,
    pd.metadata ->> 'pack_type'::text AS pack_type,
    pd.metadata ->> 'description'::text AS description,
        CASE
            WHEN (pd.metadata ->> 'retail_price_usd'::text) IS NULL THEN NULL::numeric
            WHEN ((pd.metadata ->> 'retail_price_usd'::text)::numeric) >= 1000000::numeric THEN round(((pd.metadata ->> 'retail_price_usd'::text)::numeric) / 100000000::numeric, 2)
            ELSE round((pd.metadata ->> 'retail_price_usd'::text)::numeric, 2)
        END AS retail_price_usd,
    (pd.metadata ->> 'number_of_pack_slots'::text)::integer AS slots,
    pd.total_minted,
    pd.total_opened,
    pd.total_sealed,
    pd.depletion_pct,
    pev.pack_ev,
    pev.gross_ev,
    pev.pack_price AS ev_pack_price,
    pev.value_ratio,
    pev.is_positive_ev,
    pev.fmv_coverage_pct,
    pev.edition_count,
    pev.total_unopened,
    pev.depletion_pct AS ev_depletion_pct,
    pev.snapshotted_at AS ev_snapshotted_at,
        CASE
            WHEN pev.pack_ev IS NOT NULL AND pev.pack_price > 0::numeric THEN round(pev.pack_ev / pev.pack_price * 100::numeric, 1)
            ELSE NULL::numeric
        END AS ev_margin_pct,
    pd.first_seen_at,
    pd.updated_at,
        CASE
            WHEN pev.edition_count = 1 AND pev.pack_ev > 500::numeric THEN true
            ELSE false
        END AS is_rare_single_pack,
    pev.primary_price,
    pev.secondary_ask,
    pev.price_source,
    pev.primary_available,
    pev.secondary_available
   FROM pack_distributions pd
     JOIN collections c ON c.id = pd.collection_id
     LEFT JOIN mv_pack_ev_latest pev ON pev.dist_id = pd.dist_id AND pev.collection_id = pd.collection_id;

SELECT cron.schedule('rpc-refresh-mv-pack-ev-latest', '*/10 * * * *', $$SELECT public.refresh_mv_pack_ev_latest();$$);
