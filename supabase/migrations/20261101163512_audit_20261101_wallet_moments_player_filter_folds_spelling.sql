-- audit_20261101_wallet_moments_player_filter_folds_spelling
-- anon-exec: unchanged (get_wallet_moments_with_fmv) — CREATE OR REPLACE of an existing fn; ACL preserved (anon/authenticated EXECUTE true BY DESIGN — the public collection read; verified 11-01 9:30 AM PT, and anon/authenticated can execute _norm_player + extensions.unaccent, which the new filter calls).
--
-- #221, the user-visible half. wallet_moments_cache.player_name is a denormalised copy
-- that spells one player several ways (9,842 Top Shot rows / 33 spellings, 2,286 All Day
-- rows / 60, measured 10-31). The collection tab's player filter sends one spelling and
-- this function matched it with lower(player_name) LIKE '%…%', so every other spelling
-- disappeared from a collector's own binder. Measured 11-01 on the largest Top Shot
-- wallet (0x3795d42c0fc3a373, 61,584 rows): "Luka Doncic" matched 7 Moments; the wallet
-- holds 593 — the other 586 are stored "Luka Dončić".
--
-- Fix: compare through the existing canonical normaliser public._norm_player (unaccent +
-- lower, trailing Jr/Sr/II/III/IV/V dropped, non-alphanumerics dropped; pinned in
-- supabase/tests/norm_player.sql). Folds accents (Dončić), case (DeMar/Demar DeRozan),
-- punctuation (O.G./OG Anunoby) and generational suffixes (Jimmy Butler III). It does
-- NOT merge true aliases ("Rob"/"Robert Dillingham") — that is the identity crosswalk's
-- job (rule 2), still #221's upstream exit. The client (lib/collection/filter-options.ts
-- + filter-sort.ts) collapses the dropdown and its own filter on the same key
-- (lib/filter-match.ts playerNameKey, a mirror of _norm_player).
--
-- Cost (EXPLAIN ANALYZE, same wallet, filter set): buffers IDENTICAL (37,279 shared hit);
-- 794 ms vs 193 ms — the regex is per row, only when p_player is set, against the
-- function's 30 s statement_timeout. Unfiltered reads are unchanged.
--
-- The body below is the committed 20261101051652 body (= live prosrc md5
-- 65cde89789667f6e8d115a4084ae97ec, checked before this file) with ONE line changed: the
-- p_player predicate. Header restated verbatim from that migration.
--
-- Revert: re-apply 20261101051652's get_wallet_moments_with_fmv (and revert the client
-- commit, or the dropdown offers one merged name the server matches only by exact spelling).

-- >>> BEGIN verbatim get_wallet_moments_with_fmv (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_wallet_moments_with_fmv(p_wallet text, p_sort_by text DEFAULT 'fmv_desc'::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_player text DEFAULT NULL::text, p_series integer DEFAULT NULL::integer, p_tier text DEFAULT NULL::text, p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
BEGIN
  RETURN (
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
      COALESCE(
        wmc.series_number,
        CASE WHEN p_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND e.series = 1
             THEN 0 ELSE e.series END
      ) AS series_number,
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
      wmc.is_locked AS is_locked,
      (wmc.lock_checked_at IS NOT NULL) AS lock_known,
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
      wmc.is_locked AS is_locked,
      (wmc.lock_checked_at IS NOT NULL) AS lock_known,
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
    WHERE (p_player IS NULL OR _norm_player(player_name) LIKE '%' || _norm_player(p_player) || '%')
      AND (p_series IS NULL OR series_number = p_series)
      AND (p_tier IS NULL OR lower(tier) = lower(p_tier))
  ),
  total AS (
    SELECT count(*) AS cnt FROM filtered
  ),
  -- The acquisition row the DISPLAY uses (the enriched LATERAL below: newest
  -- created_at per moment for this wallet AND collection), materialised ONLY
  -- for the Recent and Paid sorts so they order by the values the binder shows.
  acq AS (
    SELECT DISTINCT ON (ma3.nft_id) ma3.nft_id, ma3.acquired_date, ma3.buy_price
    FROM moment_acquisitions ma3
    WHERE p_sort_by IN ('recent', 'recent_asc', 'paid_desc', 'paid_asc')
      AND ma3.wallet = p_wallet
      AND ma3.collection_id = p_collection_id
    ORDER BY ma3.nft_id, ma3.created_at DESC
  ),
  paged AS (
    SELECT f.*
    FROM filtered f
    LEFT JOIN acq ON acq.nft_id = f.moment_id
    ORDER BY
      CASE WHEN p_sort_by IN ('fmv_desc', 'price_desc') THEN f.fmv_usd END DESC NULLS LAST,
      CASE WHEN p_sort_by IN ('fmv_asc', 'price_asc') THEN f.fmv_usd END ASC NULLS LAST,
      CASE WHEN p_sort_by = 'serial_asc' THEN f.serial_number END ASC NULLS LAST,
      CASE WHEN p_sort_by = 'recent' THEN COALESCE(acq.acquired_date, f.acquired_at_raw) END DESC NULLS LAST,
      CASE WHEN p_sort_by = 'recent_asc' THEN COALESCE(acq.acquired_date, f.acquired_at_raw) END ASC NULLS LAST,
      CASE WHEN p_sort_by = 'paid_desc' THEN acq.buy_price END DESC NULLS LAST,
      CASE WHEN p_sort_by = 'paid_asc' THEN acq.buy_price END ASC NULLS LAST,
      CASE WHEN p_sort_by NOT IN ('fmv_desc','price_desc','fmv_asc','price_asc','serial_asc','recent','recent_asc','paid_desc','paid_asc') THEN f.fmv_usd END DESC NULLS LAST,
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
      p.lock_known,
      p.edition_id,
      p.sales_count_30d,
      public.serial_fmv_estimate(p_collection_id, p.serial_number, p.circulation_count, p.tier, p.fmv_usd, p.confidence, p.edition_id) AS serial_fmv,
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
        AND ma2.collection_id = p_collection_id
      ORDER BY ma2.created_at DESC
      LIMIT 1
    ) ma ON true
  )
  SELECT json_build_object(
    'moments', COALESCE((SELECT json_agg(row_to_json(enriched)) FROM enriched), '[]'::json),
    'total_count', (SELECT cnt FROM total)
  )
  );
END;
$function$;
-- <<< END verbatim get_wallet_moments_with_fmv <<<
