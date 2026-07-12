-- "Hot Floors" — which Top Shot edition floors are being actively SWEPT right now.
-- Novel intelligence off the bulk-buy reverse-engineering: sessionizes the Quick-Buy
-- path (proposer = DUC) per buyer by a 20-min gap, flags sessions that are genuine
-- sweeps (>=6 moments across >=4 distinct editions), then aggregates per edition —
-- how many of its recent sales came from sweepers, how many distinct sweepers, total
-- swept spend, and its current floor + FMV. Surfaces accumulation pressure on commons
-- that neither Top Shot nor the Sets page shows.
--
-- SECDEF, service_role only (called from the Hot Floors page via the server client).
-- Revert: DROP FUNCTION get_topshot_hot_floors(integer,integer,integer,integer).

CREATE OR REPLACE FUNCTION public.get_topshot_hot_floors(
  p_days integer DEFAULT 3,
  p_min_session_moments integer DEFAULT 6,
  p_min_session_editions integer DEFAULT 4,
  p_limit integer DEFAULT 40
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_duc_proposer text := '0xead892083b3e2c6c';
  v_gap_minutes int := 20;
  v_result json;
BEGIN
  WITH base AS (
    SELECT s.buyer_address, s.sold_at, s.edition_id, s.price_usd
    FROM sales s
    WHERE s.collection_id = v_ts
      AND s.proposer_address = v_duc_proposer
      AND s.sold_at > NOW() - make_interval(days => p_days)
      AND s.buyer_address IS NOT NULL
      AND s.edition_id IS NOT NULL
      AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3', '0xedf9df96c92f4595', '0xc1e4f4f4c4257510')
  ),
  marked AS (
    SELECT b.*,
      CASE
        WHEN LAG(b.sold_at) OVER (PARTITION BY b.buyer_address ORDER BY b.sold_at) IS NULL
          OR b.sold_at - LAG(b.sold_at) OVER (PARTITION BY b.buyer_address ORDER BY b.sold_at)
             > make_interval(mins => v_gap_minutes)
        THEN 1 ELSE 0
      END AS is_new
    FROM base b
  ),
  sessioned AS (
    SELECT m.*,
      SUM(m.is_new) OVER (PARTITION BY m.buyer_address ORDER BY m.sold_at ROWS UNBOUNDED PRECEDING) AS sess
    FROM marked m
  ),
  sess_size AS (
    SELECT buyer_address, sess,
      COUNT(*) AS moments, COUNT(DISTINCT edition_id) AS distinct_editions
    FROM sessioned GROUP BY buyer_address, sess
  ),
  -- each sale tagged with whether it belongs to a genuine sweep session
  swept AS (
    SELECT s.edition_id, s.buyer_address, s.sold_at, s.price_usd
    FROM sessioned s
    JOIN sess_size z ON z.buyer_address = s.buyer_address AND z.sess = s.sess
    WHERE z.moments >= p_min_session_moments AND z.distinct_editions >= p_min_session_editions
  ),
  per_edition AS (
    SELECT edition_id,
      COUNT(*) AS swept_sales,
      COUNT(DISTINCT buyer_address) AS sweep_buyers,
      ROUND(SUM(price_usd), 2) AS swept_spend,
      MAX(sold_at) AS last_swept_at
    FROM swept GROUP BY edition_id
  ),
  floor AS (
    SELECT be.external_id, MIN(NULLIF(be.low_ask, 0)) AS low_ask
    FROM badge_editions be WHERE be.collection_id = v_ts
    GROUP BY be.external_id
  )
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.sweep_buyers DESC, t.swept_sales DESC), '[]'::json)
  INTO v_result
  FROM (
    SELECT
      e.external_id, e.set_id_onchain, e.play_id_onchain,
      e.player_name, e.set_name, e.tier::text AS tier, e.thumbnail_url,
      pe.swept_sales, pe.sweep_buyers, pe.swept_spend, pe.last_swept_at,
      f.low_ask AS floor_ask,
      fs.fmv_usd
    FROM per_edition pe
    JOIN editions e ON e.id = pe.edition_id
    LEFT JOIN floor f ON f.external_id = e.external_id
    LEFT JOIN LATERAL (
      SELECT fmv_usd FROM fmv_snapshots fsx
      WHERE fsx.edition_id = pe.edition_id ORDER BY computed_at DESC LIMIT 1
    ) fs ON true
    ORDER BY pe.sweep_buyers DESC, pe.swept_sales DESC
    LIMIT p_limit
  ) t;

  RETURN json_build_object('window_days', p_days, 'generated_at', NOW(), 'editions', v_result);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_topshot_hot_floors(integer,integer,integer,integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_topshot_hot_floors(integer,integer,integer,integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_hot_floors(integer,integer,integer,integer) TO service_role;
