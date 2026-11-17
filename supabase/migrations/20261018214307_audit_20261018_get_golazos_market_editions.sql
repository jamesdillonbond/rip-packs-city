-- audit_20261018_get_golazos_market_editions
--
-- WHY. /api/market had no Golazos arm: fetchModernListings returned null for it,
-- so /laliga-golazos/market fell through to v1 `cached_listings`, which holds only
-- Flowty's book there (100 rows, 2026-10-18) against ~4.3k open asks across ~496
-- editions in the on-chain index (cached_listings_v2, kept by
-- golazos-storefront-reconcile). The page showed Flowty's slice as the market,
-- and on the day Flowty's API goes dark it would show nothing.
--
-- SHAPE. Same signature and columns as get_allday_market_editions_v3, so the
-- route's rpcBrowseFilterArgs() and row mapping apply unchanged. One row per
-- Golazos edition with an open ask: floor, live listed count, newest listing,
-- latest FMV within 90 days (the v3 rule; unpriced reads 'ASK_ONLY', as there).
-- Open = completed_at IS NULL, price > 0, not expired (the golazos_edition_floor_ask
-- predicate). Golazos is ~500 listed editions, so it aggregates then sorts;
-- p_min_discount is accepted for signature parity and filters after FMV.
--
-- ACCESS. SECURITY DEFINER like v3, service_role only.
-- anon-exec: intentional — new function, REVOKED from PUBLIC, anon, authenticated at creation; GRANT service_role (get_golazos_market_editions)
--
-- REVERT: DROP FUNCTION public.get_golazos_market_editions(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text);

CREATE OR REPLACE FUNCTION public.get_golazos_market_editions(
  p_min_discount numeric DEFAULT 0,
  p_max_price    numeric DEFAULT 0,
  p_rarity       text    DEFAULT 'all',
  p_team         text    DEFAULT 'all',
  p_sort_by      text    DEFAULT 'listed_desc',
  p_limit        integer DEFAULT 500,
  p_sets         text[]  DEFAULT NULL,
  p_series       text[]  DEFAULT NULL,
  p_player       text    DEFAULT NULL,
  p_min_price    numeric DEFAULT 0,
  p_teams        text[]  DEFAULT NULL,
  p_badges       text[]  DEFAULT NULL,
  p_has_badges   boolean DEFAULT false,
  p_wallet       text    DEFAULT NULL,
  p_owned        text    DEFAULT NULL
)
RETURNS TABLE (
  edition_id uuid, external_id text, player_name text, team_name text, set_name text,
  series_name text, tier text, circulation_count integer, floor_ask numeric,
  listed_count integer, fmv_usd numeric, discount_pct numeric, confidence text,
  thumbnail_url text, badges text[], last_listed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH agg AS (
    SELECT cl.edition_id,
           min(cl.price_usd)  AS floor_ask,
           count(*)::int      AS listed_count,
           max(cl.listed_at)  AS last_listed_at
      FROM cached_listings_v2 cl
     WHERE cl.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid
       AND cl.completed_at IS NULL
       AND cl.edition_id IS NOT NULL
       AND cl.price_usd > 0
       AND (cl.expiry_at IS NULL OR cl.expiry_at > now())
     GROUP BY cl.edition_id
  ), rows AS (
    SELECT e.id AS eid, e.external_id::text AS ext, e.player_name::text AS pn,
           e.team_name::text AS tn, e.set_name::text AS sn, e.series::text AS ser,
           e.tier::text AS tr, e.circulation_count AS circ, g.floor_ask AS f_ask,
           g.listed_count AS l_count, fs.fmv_usd AS fmv,
           CASE WHEN fs.fmv_usd IS NOT NULL AND fs.fmv_usd > 0
                THEN ROUND(((fs.fmv_usd - g.floor_ask) / fs.fmv_usd) * 100, 1)
           END AS disc,
           COALESCE(fs.confidence::text, 'ASK_ONLY') AS conf,
           e.thumbnail_url::text AS thumb, e.badges AS bdg, g.last_listed_at AS ll_at
      FROM agg g
      JOIN editions e ON e.id = g.edition_id
      LEFT JOIN LATERAL (
        SELECT s.fmv_usd, s.confidence
          FROM fmv_snapshots s
         WHERE s.edition_id = e.id AND s.fmv_usd IS NOT NULL
           AND s.computed_at > now() - interval '90 days'
         ORDER BY s.computed_at DESC
         LIMIT 1
      ) fs ON true
     WHERE (p_rarity = 'all' OR UPPER(e.tier::text) = UPPER(p_rarity))
       AND (p_team = 'all' OR e.team_name ILIKE p_team)
       AND (COALESCE(cardinality(p_teams), 0) = 0 OR btrim(e.team_name) ILIKE ANY (p_teams))
       AND (COALESCE(cardinality(p_badges), 0) = 0 OR EXISTS (SELECT 1 FROM market_edition_badges mb JOIN market_edition_badges_runs mr ON mr.collection_id = mb.collection_id AND mr.last_run_at = mb.refreshed_at WHERE mb.edition_id = e.id AND mb.title = ANY (p_badges)))
       AND (NOT COALESCE(p_has_badges, false) OR EXISTS (SELECT 1 FROM market_edition_badges mb JOIN market_edition_badges_runs mr ON mr.collection_id = mb.collection_id AND mr.last_run_at = mb.refreshed_at WHERE mb.edition_id = e.id))
       AND (p_owned IS NULL OR p_wallet IS NULL
            OR (p_owned = 'owned'     AND     EXISTS (SELECT 1 FROM wallet_moments_cache w WHERE w.wallet_address = p_wallet AND w.collection_id = e.collection_id AND w.edition_key = e.external_id))
            OR (p_owned = 'not_owned' AND NOT EXISTS (SELECT 1 FROM wallet_moments_cache w WHERE w.wallet_address = p_wallet AND w.collection_id = e.collection_id AND w.edition_key = e.external_id)))
       AND (COALESCE(p_max_price, 0) = 0 OR g.floor_ask <= p_max_price)
       AND (COALESCE(cardinality(p_sets), 0) = 0 OR btrim(e.set_name) IN (SELECT btrim(x) FROM unnest(p_sets) x))
       AND (COALESCE(cardinality(p_series), 0) = 0 OR e.series::text = ANY (p_series))
       AND (COALESCE(btrim(p_player), '') = '' OR e.player_name ILIKE '%' || btrim(p_player) || '%')
       AND (COALESCE(p_min_price, 0) = 0 OR g.floor_ask >= p_min_price)
  )
  SELECT r.eid, r.ext, r.pn, r.tn, r.sn, r.ser, r.tr, r.circ, r.f_ask, r.l_count,
         r.fmv, r.disc, r.conf, r.thumb, r.bdg, r.ll_at
    FROM rows r
   WHERE COALESCE(p_min_discount, 0) = 0 OR r.disc >= p_min_discount
   ORDER BY
     CASE WHEN p_sort_by = 'price_asc'     THEN r.f_ask END ASC  NULLS LAST,
     CASE WHEN p_sort_by = 'price_desc'    THEN r.f_ask END DESC NULLS LAST,
     CASE WHEN p_sort_by = 'fmv_asc'       THEN r.fmv   END ASC  NULLS LAST,
     CASE WHEN p_sort_by = 'fmv_desc'      THEN r.fmv   END DESC NULLS LAST,
     CASE WHEN p_sort_by = 'discount_asc'  THEN r.disc  END ASC  NULLS LAST,
     CASE WHEN p_sort_by = 'discount_desc' THEN r.disc  END DESC NULLS LAST,
     r.ll_at DESC NULLS LAST,
     r.eid
   LIMIT COALESCE(p_limit, 500);
$$;

REVOKE EXECUTE ON FUNCTION public.get_golazos_market_editions(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_golazos_market_editions(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text) TO service_role;
