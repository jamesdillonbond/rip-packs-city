-- Bridge integer-format edition keys (e.g. "26:504") to UUID-format editions
-- that have fmv_snapshots data, using name + series as the join key.
-- This resolves the mismatch where wallet_moments_cache stores integer keys
-- but FMV data lives on UUID editions created by the ingest pipeline.

CREATE OR REPLACE FUNCTION get_wallet_moments_with_fmv(
  p_wallet text,
  p_sort_by text DEFAULT 'fmv_desc',
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0,
  p_player text DEFAULT NULL,
  p_series int DEFAULT NULL,
  p_tier text DEFAULT NULL
)
RETURNS json
LANGUAGE sql
STABLE
AS $$
  WITH latest_fmv AS (
    SELECT DISTINCT ON (edition_id)
      edition_id, fmv_usd, confidence::text AS confidence, floor_price_usd
    FROM fmv_snapshots
    ORDER BY edition_id, computed_at DESC
  ),
  -- For each integer-format edition, find the best UUID sibling FMV via name+series
  sibling_fmv AS (
    SELECT DISTINCT ON (int_ed.id)
      int_ed.id AS int_edition_id,
      lf.fmv_usd,
      lf.confidence,
      lf.floor_price_usd
    FROM editions int_ed
    JOIN editions uuid_ed ON uuid_ed.name = int_ed.name
      AND uuid_ed.series = int_ed.series
      AND uuid_ed.id != int_ed.id
    JOIN latest_fmv lf ON lf.edition_id = uuid_ed.id
    WHERE int_ed.external_id ~ '^\d+:\d+$'
    ORDER BY int_ed.id, lf.fmv_usd DESC NULLS LAST
  ),
  base AS (
    SELECT
      wmc.moment_id,
      wmc.edition_key,
      wmc.serial_number,
      COALESCE(wmc.player_name,
        CASE WHEN position(' — ' in COALESCE(e.name, '')) > 0
             THEN trim(split_part(e.name, ' — ', 1))
             ELSE e.name END
      ) AS player_name,
      COALESCE(wmc.set_name,
        CASE WHEN position(' — ' in COALESCE(e.name, '')) > 0
             THEN trim(split_part(e.name, ' — ', 2))
             ELSE NULL END
      ) AS set_name,
      COALESCE(wmc.tier, e.tier::text) AS tier,
      COALESCE(wmc.series_number, e.series) AS series_number,
      e.circulation_count,
      COALESCE(lf.fmv_usd, sf.fmv_usd, wmc.fmv_usd) AS fmv_usd,
      COALESCE(lf.confidence, sf.confidence) AS confidence,
      COALESCE(lf.floor_price_usd, sf.floor_price_usd) AS low_ask,
      wmc.acquired_at,
      wmc.last_seen_at
    FROM wallet_moments_cache wmc
    LEFT JOIN editions e ON e.external_id = wmc.edition_key
    LEFT JOIN latest_fmv lf ON lf.edition_id = e.id
    LEFT JOIN sibling_fmv sf ON sf.int_edition_id = e.id AND lf.edition_id IS NULL
    WHERE wmc.wallet_address = p_wallet
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
  sorted AS (
    SELECT f.* FROM filtered f
    ORDER BY
      CASE WHEN p_sort_by IN ('fmv_desc', 'price_desc') THEN f.fmv_usd END DESC NULLS LAST,
      CASE WHEN p_sort_by IN ('fmv_asc', 'price_asc') THEN f.fmv_usd END ASC NULLS LAST,
      CASE WHEN p_sort_by = 'serial_asc' THEN f.serial_number END ASC NULLS LAST,
      CASE WHEN p_sort_by = 'recent' THEN f.last_seen_at END DESC NULLS LAST,
      CASE WHEN p_sort_by NOT IN ('fmv_desc','price_desc','fmv_asc','price_asc','serial_asc','recent') THEN f.fmv_usd END DESC NULLS LAST,
      f.moment_id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT json_build_object(
    'moments', COALESCE((SELECT json_agg(row_to_json(s)) FROM sorted s), '[]'::json),
    'total_count', (SELECT cnt FROM total)
  );
$$;

CREATE OR REPLACE FUNCTION get_wallet_total_fmv(p_wallet text)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  WITH latest_fmv AS (
    SELECT DISTINCT ON (edition_id)
      edition_id, fmv_usd
    FROM fmv_snapshots
    ORDER BY edition_id, computed_at DESC
  ),
  sibling_fmv AS (
    SELECT DISTINCT ON (int_ed.id)
      int_ed.id AS int_edition_id,
      lf.fmv_usd
    FROM editions int_ed
    JOIN editions uuid_ed ON uuid_ed.name = int_ed.name
      AND uuid_ed.series = int_ed.series
      AND uuid_ed.id != int_ed.id
    JOIN latest_fmv lf ON lf.edition_id = uuid_ed.id
    WHERE int_ed.external_id ~ '^\d+:\d+$'
    ORDER BY int_ed.id, lf.fmv_usd DESC NULLS LAST
  )
  SELECT COALESCE(SUM(COALESCE(lf.fmv_usd, sf.fmv_usd, wmc.fmv_usd)), 0)
  FROM wallet_moments_cache wmc
  LEFT JOIN editions e ON e.external_id = wmc.edition_key
  LEFT JOIN latest_fmv lf ON lf.edition_id = e.id
  LEFT JOIN sibling_fmv sf ON sf.int_edition_id = e.id AND lf.edition_id IS NULL
  WHERE wmc.wallet_address = p_wallet;
$$;
