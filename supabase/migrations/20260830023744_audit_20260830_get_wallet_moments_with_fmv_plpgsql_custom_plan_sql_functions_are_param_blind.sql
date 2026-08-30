-- audit_20260830_get_wallet_moments_with_fmv_plpgsql_custom_plan_sql_functions_are_param_blind
--
-- WHY: /api/collection-moments failed 10/18 in the 2026-08-30 01:12Z cloud pass on the
-- 15,181-moment Top Shot wallet 0xbd94cade097e50ac (139,922 shared buffers + 722 temp,
-- 7-24 s cold). The pass blamed heap fetches on fmv_snapshots_2026 (last_vacuum NULL).
-- FALSIFIED 02:29Z: a cron_heavy `VACUUM (ANALYZE) public.fmv_snapshots_2026` (jobid 396,
-- 9 s, relallvisible = relpages afterwards) left the call at 139,922 buffers — identical.
--
-- MECHANISM (established): the function is LANGUAGE sql. On PG 17 a non-inlined SQL-language
-- function body is planned WITHOUT its parameter values (fmgr_sql -> pg_plan_query with
-- boundParams = NULL), i.e. always the GENERIC plan. Emulated with
-- `SET plan_cache_mode = force_generic_plan` + PREPARE: 134,257 buffers, rows=666 estimated
-- for the wallet (the per-wallet average) -> Nested Loop into editions by
-- editions_external_id_collection_id_key per moment (60,544 buffers) instead of the
-- Hash Join over idx_editions_collection (3,874 buffers). A custom plan with the real
-- wallet value chose the hash join: 75,395 buffers. Wall clock is IO-confounded (the same
-- 140k-buffer call ran 7.1 s cold with 5,313 reads and 0.31 s warm) — buffers are the figure.
--
-- FIX: same body, LANGUAGE plpgsql (RETURN (<the exact SELECT>)) so the statement goes
-- through the plan cache with parameter values, plus `plan_cache_mode = force_custom_plan`
-- on the function — without it plpgsql would flip to the generic plan after 5 calls because
-- the generic plan's ESTIMATED cost (3,575) is far below the custom plan's (64,043).
-- Nothing else changes: same signature, defaults, STABLE, timeouts, search_path, envelope.
--
-- VERIFIED before apply (probe copy get_wallet_moments_with_fmv__plpgsql_probe, dropped):
--   * jsonb equality old = new on 13 param sets: small/mid/15k Top Shot wallets, an All Day
--     wallet (p_series=1), a Pinnacle wallet (pin arm), sorts fmv_desc/fmv_asc/serial_asc/
--     recent/paid_desc/paid_asc/bogus, player + series + tier filters, offsets, a
--     non-existent wallet -> {moments:[],total_count:0}. 13/13 equal.
--   * buffers: 15k wallet 139,922 -> 80,986 (-42%); 945-moment wallet 14,864 -> 13,306
--     (no regression; the nested loop is right for small wallets and the custom plan keeps it).
--
-- The remaining ~60k buffers are the fmv_snapshots LATERAL probed once per MOMENT (15,181)
-- rather than per EDITION (6,865); that is a body change and stays open (known-issues #52).
--
-- Pinned by supabase/tests/get_wallet_moments_with_fmv.sql (verbatim copy re-pointed to
-- this file in __tests__/db-invariants-drift-guard.test.ts).
--
-- REVERT: re-apply the CREATE OR REPLACE from
--   supabase/migrations/20260806033000_audit_20260806_get_wallet_moments_series_topshot_convention.sql
-- (LANGUAGE sql, no plan_cache_mode) and re-point the PINS entry + verbatim copy back.

-- anon-exec: intentional — same signature, ACLs unchanged by CREATE OR REPLACE; the un-gated collection tab and /share/[wallet] read it anon (get_wallet_moments_with_fmv).
-- (this marker line was added to the committed file after apply; it is a comment only, so the
-- file is no longer byte-identical to prod's recorded statements — parity is by name.)
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
