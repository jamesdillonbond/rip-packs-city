-- Denormalize team_name onto wallet_moments_cache (the WMC-backfill convention
-- already used for tier/player_name/set_name/mint_count/image_url).
--
-- Motivation (was a TODO in components/collection/CollectionMomentTable.tsx):
-- the collection-moments read path sourced Team straight from editions.team_name,
-- which is unreliable for churn-prone / re-keyed edition rows. Capturing the
-- value on wmc at backfill time (keyed by the same edition_key the row already
-- resolves through) makes Team resilient to later editions churn and lets other
-- consumers read wmc.team_name directly, matching the sibling denorm columns.
--
-- Reversal:
--   ALTER TABLE public.wallet_moments_cache DROP COLUMN team_name;
--   (and restore the two functions from prior migration history)

ALTER TABLE public.wallet_moments_cache
  ADD COLUMN IF NOT EXISTS team_name text;

-- Fold team_name into the warm/refresh backfill so new + refreshed rows keep it
-- current (same NULL-only, COALESCE-preserving shape as the other columns).
CREATE OR REPLACE FUNCTION public.backfill_wmc_metadata_from_editions(
  p_wallet_address text DEFAULT NULL::text,
  p_collection_id  uuid DEFAULT NULL::uuid
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  WITH updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET tier        = COALESCE(wmc.tier,        e.tier::text),
           player_name = COALESCE(wmc.player_name, e.player_name, e.team_name),
           set_name    = COALESCE(wmc.set_name,    e.set_name),
           mint_count  = COALESCE(wmc.mint_count,  e.circulation_count),
           team_name   = COALESCE(wmc.team_name,   e.team_name)
      FROM public.editions e
     WHERE e.collection_id = wmc.collection_id
       AND e.external_id   = wmc.edition_key
       AND wmc.edition_key IS NOT NULL
       AND (
         wmc.tier IS NULL OR
         wmc.player_name IS NULL OR
         wmc.set_name IS NULL OR
         wmc.mint_count IS NULL OR
         wmc.team_name IS NULL
       )
       AND (p_wallet_address IS NULL OR wmc.wallet_address = p_wallet_address)
       AND (p_collection_id  IS NULL OR wmc.collection_id  = p_collection_id)
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_updated FROM updated;

  RETURN COALESCE(v_updated, 0);
END;
$function$;

-- Prefer the wmc-captured team over the live editions join in the read path.
-- Additive: falls back to e.team_name when wmc.team_name is NULL, so behavior is
-- identical for un-backfilled rows.
CREATE OR REPLACE FUNCTION public.get_wallet_moments_with_fmv(p_wallet text, p_sort_by text DEFAULT 'fmv_desc'::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_player text DEFAULT NULL::text, p_series integer DEFAULT NULL::integer, p_tier text DEFAULT NULL::text, p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH
  pin_uuid AS (SELECT '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid AS u),
  base_other AS (
    SELECT
      wmc.moment_id,
      wmc.edition_key,
      NULL::text AS render_id,
      wmc.serial_number,
      COALESCE(
        wmc.player_name, e.player_name,
        CASE WHEN position(' — ' in COALESCE(e.name, '')) > 0
             THEN trim(split_part(e.name, ' — ', 1)) ELSE e.name END
      ) AS player_name,
      COALESCE(
        wmc.set_name, e.set_name,
        CASE WHEN position(' — ' in COALESCE(e.name, '')) > 0
             THEN trim(split_part(e.name, ' — ', 2)) ELSE NULL END
      ) AS set_name,
      COALESCE(wmc.tier, e.tier::text) AS tier,
      COALESCE(wmc.series_number, e.series) AS series_number,
      e.circulation_count,
      COALESCE(wmc.team_name, e.team_name) AS team_name,
      e.thumbnail_url,
      e.name AS edition_name,
      lf.fmv_usd,
      lf.confidence,
      lf.floor_price_usd AS low_ask,
      lf.algo_version AS fmv_method,
      wmc.acquired_at AS acquired_at_raw,
      wmc.last_seen_at,
      COALESCE(wmc.is_locked, false) AS is_locked,
      e.id AS edition_id,
      lf.sales_count_30d
    FROM wallet_moments_cache wmc
    LEFT JOIN editions e ON e.external_id = wmc.edition_key AND e.collection_id = p_collection_id
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence::text AS confidence, fs.floor_price_usd, fs.algo_version, fs.sales_count_30d
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id AND fs.computed_at <= now()
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) lf ON true
    WHERE wmc.wallet_address = p_wallet
      AND wmc.collection_id = p_collection_id
      AND p_collection_id <> (SELECT u FROM pin_uuid)
  ),
  base_pinnacle AS (
    SELECT
      wmc.moment_id,
      wmc.edition_key,
      wmc.render_id,
      wmc.serial_number,
      COALESCE(pc.character_name, wmc.character_name, wmc.player_name) AS player_name,
      COALESCE(pc.set_name, wmc.set_name) AS set_name,
      COALESCE(pc.variant, wmc.tier) AS tier,
      NULL::integer AS series_number,
      COALESCE(pc.total_minted, wmc.mint_count) AS circulation_count,
      NULL::text AS team_name,
      COALESCE(wmc.image_url,
               CASE WHEN wmc.render_id IS NOT NULL
                    THEN '/api/public/pinnacle-image/' || wmc.render_id END) AS thumbnail_url,
      (COALESCE(pc.character_name, wmc.character_name, 'Pin')
        || COALESCE(' — ' || COALESCE(pc.set_name, wmc.set_name), '')
        || COALESCE(' (' || pc.variant || ')', '')) AS edition_name,
      pc.fmv_usd,
      pc.fmv_confidence::text AS confidence,
      pc.floor_ask AS low_ask,
      pc.fmv_algo_version AS fmv_method,
      wmc.acquired_at AS acquired_at_raw,
      wmc.last_seen_at,
      false AS is_locked,
      NULL::uuid AS edition_id,
      NULL::integer AS sales_count_30d
    FROM wallet_moments_cache wmc
    LEFT JOIN pinnacle_catalog pc ON pc.render_id = wmc.render_id
    WHERE wmc.wallet_address = p_wallet
      AND wmc.collection_id = p_collection_id
      AND p_collection_id = (SELECT u FROM pin_uuid)
  ),
  base AS (
    SELECT * FROM base_other UNION ALL SELECT * FROM base_pinnacle
  ),
  filtered AS (
    SELECT * FROM base
    WHERE (p_player IS NULL OR lower(player_name) LIKE '%' || lower(p_player) || '%')
      AND (p_series IS NULL OR series_number = p_series)
      AND (p_tier IS NULL OR lower(tier) = lower(p_tier))
  ),
  total AS (
    SELECT count(*) AS cnt FROM filtered
  ),
  paged AS (
    SELECT f.*
    FROM filtered f
    ORDER BY
      CASE WHEN p_sort_by IN ('fmv_desc', 'price_desc') THEN f.fmv_usd END DESC NULLS LAST,
      CASE WHEN p_sort_by IN ('fmv_asc', 'price_asc') THEN f.fmv_usd END ASC NULLS LAST,
      CASE WHEN p_sort_by = 'serial_asc' THEN f.serial_number END ASC NULLS LAST,
      CASE WHEN p_sort_by = 'recent' THEN f.last_seen_at END DESC NULLS LAST,
      CASE WHEN p_sort_by = 'paid_desc' THEN (
        SELECT ma2.buy_price FROM moment_acquisitions ma2
        WHERE ma2.nft_id = f.moment_id AND ma2.wallet = p_wallet
        ORDER BY ma2.created_at DESC LIMIT 1
      ) END DESC NULLS LAST,
      CASE WHEN p_sort_by = 'paid_asc' THEN (
        SELECT ma2.buy_price FROM moment_acquisitions ma2
        WHERE ma2.nft_id = f.moment_id AND ma2.wallet = p_wallet
        ORDER BY ma2.created_at DESC LIMIT 1
      ) END ASC NULLS LAST,
      CASE WHEN p_sort_by NOT IN ('fmv_desc','price_desc','fmv_asc','price_asc','serial_asc','recent','paid_desc','paid_asc') THEN f.fmv_usd END DESC NULLS LAST,
      f.moment_id
    LIMIT p_limit OFFSET p_offset
  ),
  enriched AS (
    SELECT
      p.moment_id,
      p.edition_key,
      p.render_id,
      p.serial_number,
      p.player_name,
      p.set_name,
      p.tier,
      p.series_number,
      p.circulation_count,
      p.team_name,
      p.thumbnail_url,
      p.edition_name,
      p.fmv_usd,
      p.confidence,
      p.low_ask,
      p.fmv_method,
      COALESCE(ma.acquired_date, p.acquired_at_raw) AS acquired_at,
      p.last_seen_at,
      ma.buy_price,
      ma.acquisition_method,
      ma.acquisition_confidence,
      ma.source AS acquisition_source,
      ma.source_address,
      ma.loan_principal,
      p.is_locked,
      p.edition_id,
      p.sales_count_30d,
      public.serial_fmv_estimate(p_collection_id, p.serial_number, p.circulation_count, p.tier, p.fmv_usd, p.confidence) AS serial_fmv,
      CASE
        WHEN p.confidence IN ('LOW', 'MEDIUM')
             AND COALESCE(p.sales_count_30d, 0) >= 10
             AND p.edition_id IS NOT NULL
        THEN (
          WITH raw AS (
            SELECT s.price_usd::numeric AS pr
            FROM sales s
            WHERE s.edition_id = p.edition_id
              AND s.sold_at >= now() - interval '30 days'
              AND s.price_usd IS NOT NULL
              AND s.price_usd >= 0.50
          ),
          med AS (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pr) AS m FROM raw),
          cleaned AS (
            SELECT r.pr FROM raw r CROSS JOIN med
            WHERE med.m IS NULL OR r.pr <= med.m * 5
          )
          SELECT CASE WHEN count(*) >= 5 THEN jsonb_build_object(
                   'low',  round(percentile_cont(0.10) WITHIN GROUP (ORDER BY pr)::numeric, 2),
                   'high', round(percentile_cont(0.90) WITHIN GROUP (ORDER BY pr)::numeric, 2),
                   'n', count(*)
                 ) ELSE NULL END
          FROM cleaned
        )
        ELSE NULL
      END AS price_band_30d
    FROM paged p
    LEFT JOIN LATERAL (
      SELECT ma2.buy_price, ma2.acquisition_method, ma2.acquisition_confidence,
             ma2.source, ma2.source_address, ma2.acquired_date, ma2.loan_principal
      FROM moment_acquisitions ma2
      WHERE ma2.nft_id = p.moment_id AND ma2.wallet = p_wallet
      ORDER BY ma2.created_at DESC
      LIMIT 1
    ) ma ON true
  )
  SELECT json_build_object(
    'moments', COALESCE((SELECT json_agg(row_to_json(enriched)) FROM enriched), '[]'::json),
    'total_count', (SELECT cnt FROM total)
  );
$function$;

COMMENT ON COLUMN public.wallet_moments_cache.team_name IS
  'Denormalized team from editions.team_name, captured at backfill time (backfill_wmc_metadata_from_editions). Preferred over the live editions join in get_wallet_moments_with_fmv so Team survives editions re-keying/churn. Pinnacle rows stay NULL (no team concept).';
