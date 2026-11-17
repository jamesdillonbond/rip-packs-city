-- audit_20260726_serial_fmv_consumers_pooled_edition_id
-- Parity record for the four SECDEF consumer functions cut over to pass p_edition_id to serial_fmv_estimate,
-- so their #1/perfect serial estimates use the pooled multi-factor model (basis pooled_model) instead of the
-- tier-coarse power-law — extending the model past the deal board to the moment page, wallet holdings, trophy
-- case, and top-owned board. Each change is a SINGLE added argument (the edition id already in scope);
-- unresolved / non-TS editions fall through to the UNCHANGED power-law/grid path (no regression). Applied
-- individually via MCP (audit_20260726_get_{moment_detail,trophy_slab_data,wallet_moments_with_fmv,user_top_owned_moments}_pooled_edition_id);
-- the full bodies are reproduced here for the repo.
-- REVERT: drop the added edition-id argument from each serial_fmv_estimate call (prior bodies in migration
-- history / pg_get_functiondef). The pooled model tables/read-path are untouched by this migration.

-- 1. get_user_top_owned_moments -- serial_fmv_estimate(..., sf.confidence::text, e.id)  [7-arg uuid]
CREATE OR REPLACE FUNCTION public.get_user_top_owned_moments(p_user_id uuid, p_limit integer DEFAULT 24, p_league text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(moment_id text, collection_id uuid, collection_slug text, wallet_address text, player_name text, set_name text, tier text, serial_number integer, mint_count integer, fmv_usd numeric, image_url text, is_locked boolean, series_number integer, edition_key text, character_name text, edition_name text, league text, serial_fmv jsonb, team_name text, jersey_number integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH user_wallets AS (
    SELECT DISTINCT wallet_addr FROM saved_wallets WHERE user_id = p_user_id
  ),
  filtered AS (
    SELECT wmc.*
    FROM wallet_moments_cache wmc
    JOIN user_wallets uw ON uw.wallet_addr = wmc.wallet_address
    WHERE wmc.fmv_usd IS NOT NULL AND wmc.fmv_usd > 0
      AND (p_league IS NULL OR wmc.league = p_league)
      AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
  ),
  ranked AS (
    SELECT
      f.*,
      ROW_NUMBER() OVER (
        PARTITION BY f.moment_id, f.collection_id
        ORDER BY f.fmv_usd DESC NULLS LAST, f.last_seen_at DESC
      ) AS rn
    FROM filtered f
  )
  SELECT
    r.moment_id, r.collection_id, c.slug::TEXT, r.wallet_address,
    r.player_name, r.set_name, r.tier, r.serial_number, r.mint_count,
    r.fmv_usd,
    COALESCE(
      r.image_url,
      e.thumbnail_url,
      NULLIF(pe.thumbnail_url, 'https://assets.disneypinnacle.com/on-chain/pinnacle.jpg'),
      CASE
        WHEN c.slug = 'nba_top_shot' THEN
          'https://assets.nbatopshot.com/media/' || r.moment_id || '/image?width=512'
        ELSE NULL
      END
    ) AS image_url,
    r.is_locked, r.series_number, r.edition_key, r.character_name,
    r.edition_name, r.league,
    public.serial_fmv_estimate(r.collection_id, r.serial_number, r.mint_count, r.tier, sf.fmv_usd, sf.confidence::text, e.id) AS serial_fmv,
    e.team_name,
    e.jersey_number::integer
  FROM ranked r
  LEFT JOIN collections c ON c.id = r.collection_id
  LEFT JOIN editions e
    ON e.collection_id = r.collection_id
   AND e.external_id = r.edition_key
  LEFT JOIN pinnacle_editions pe
    ON c.slug = 'disney_pinnacle'
   AND pe.edition_key = r.edition_key
  LEFT JOIN LATERAL (
    SELECT fs.fmv_usd, fs.confidence
    FROM fmv_snapshots fs
    WHERE fs.edition_id = e.id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) sf ON true
  WHERE r.rn = 1
  ORDER BY r.fmv_usd DESC NULLS LAST
  LIMIT p_limit;
END;
$function$;

-- 2. get_trophy_slab_data -- serial_fmv_estimate(..., f.confidence::text, (jersey), e.id)  [8-arg]
CREATE OR REPLACE FUNCTION public.get_trophy_slab_data(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  WITH slabs AS (
    SELECT
      tm.id, tm.slot, tm.moment_id, tm.edition_id,
      COALESCE(e.player_name, tm.player_name) AS player_name,
      COALESCE(e.set_name,    tm.set_name)    AS set_name,
      tm.serial_number,
      COALESCE(e.circulation_count, tm.circulation_count) AS circulation_count,
      COALESCE(e.tier::text, tm.tier) AS tier,
      tm.thumbnail_url,
      COALESCE(e.video_url, tm.video_url) AS video_url,
      COALESCE(f.fmv_usd, tm.fmv) AS fmv,
      f.confidence AS fmv_confidence,
      -- Phase 2 serial-adjusted FMV (additive; owner surface renders it now).
      public.serial_fmv_estimate(
        tm.collection_id,
        tm.serial_number,
        COALESCE(e.circulation_count, tm.circulation_count),
        COALESCE(e.tier::text, tm.tier),
        COALESCE(f.fmv_usd, tm.fmv),
        f.confidence::text,
        (CASE WHEN e.jersey_number > 1 THEN e.jersey_number END),
        e.id
      ) AS serial_fmv,
      COALESCE(
        CASE WHEN e.id IS NOT NULL THEN (
          SELECT jsonb_agg(elem->>'title')
          FROM jsonb_array_elements(public.get_edition_badges_unified(e.id)) elem
          WHERE elem->>'title' IS NOT NULL
        ) END,
        to_jsonb(tm.badges)
      ) AS badges,
      tm.note,
      tm.collection_id,
      c.slug AS collection_slug,
      c.name AS collection_display_name,
      e.play_category AS play_description,
      e.team_name AS team_name,
      e.series AS series,
      tm.pinned_at,
      (
        SELECT ma.buy_price FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
        ORDER BY ma.acquired_date DESC NULLS LAST
        LIMIT 1
      ) AS acquired_price,
      (
        SELECT ma.acquisition_method FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
        ORDER BY ma.acquired_date DESC NULLS LAST
        LIMIT 1
      ) AS acquisition_method
    FROM trophy_moments tm
    LEFT JOIN LATERAL (
      SELECT w.edition_key
      FROM wallet_moments_cache w
      WHERE w.moment_id = tm.moment_id
        AND w.collection_id = tm.collection_id
        AND w.edition_key IS NOT NULL
      LIMIT 1
    ) wk ON true
    LEFT JOIN editions e
      ON e.external_id    = COALESCE(wk.edition_key, tm.edition_id)
     AND e.collection_id  = tm.collection_id
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) f ON true
    LEFT JOIN collections c ON c.id = tm.collection_id
    WHERE tm.user_id = p_user_id
    ORDER BY tm.slot ASC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(slabs.*) ORDER BY slot), '[]'::jsonb)
  INTO v_result FROM slabs;

  RETURN v_result;
END;
$function$;

-- 3. get_wallet_moments_with_fmv -- serial_fmv_estimate(..., p.confidence, p.edition_id)  [7-arg uuid]
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
  );
$function$;

-- 4. get_moment_detail -- serial_fmv_estimate(..., (jersey), v_resolved.edition_id)  [8-arg]
CREATE OR REPLACE FUNCTION public.get_moment_detail(p_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_resolved      RECORD;
  v_edition       JSONB;
  v_fmv           JSONB;
  v_serial        JSONB := NULL;
  v_serial_fmv    JSONB := NULL;
  v_recent_sales  JSONB;
  v_similar       JSONB;
  v_renders       JSONB := NULL;
  v_price_band    JSONB := NULL;
BEGIN
  SELECT * INTO v_resolved FROM public.resolve_moment_id(p_id) LIMIT 1;

  IF v_resolved IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'input', p_id);
  END IF;

  IF v_resolved.kind = 'pinnacle_edition' THEN
    SELECT jsonb_build_object(
      'id', pe.id, 'external_id', pe.external_id,
      'character_name', pe.character_name, 'franchise', pe.franchise,
      'set_name', pe.set_name, 'variant_type', pe.variant_type,
      'edition_type', pe.edition_type, 'series_year', pe.series_year,
      'printing', pe.printing, 'mint_count', pe.mint_count,
      'is_serialized', pe.is_serialized, 'is_chaser', pe.is_chaser,
      'thumbnail_url', pe.thumbnail_url, 'studio', pe.studio,
      'materials', pe.materials, 'effects', pe.effects,
      'edition_key', pe.edition_key, 'ask_price', pe.ask_price,
      'ask_source', pe.ask_source, 'collection_slug', 'disney_pinnacle'
    )
    INTO v_edition
    FROM pinnacle_editions pe
    WHERE pe.id = v_resolved.pinnacle_edition_id;

    SELECT jsonb_build_object(
      'fmv_usd', f.fmv_usd, 'floor_usd', f.floor_usd,
      'wap_usd', f.wap_usd, 'confidence', f.confidence,
      'sales_count_7d', f.sales_count_7d, 'sales_count_30d', f.sales_count_30d,
      'days_since_sale', f.days_since_sale, 'computed_at', f.computed_at,
      'algo_version', 'pinnacle-render-collapse', 'pinnacle_ask', f.floor_usd,
      'flowty_ask', NULL::numeric,
      'fmv_min', f.fmv_min, 'fmv_max', f.fmv_max, 'render_count', f.render_count
    )
    INTO v_fmv
    FROM public.get_pinnacle_edition_fmv_collapsed(v_resolved.pinnacle_edition_id) f;

    SELECT jsonb_agg(r ORDER BY r.fmv_usd DESC NULLS LAST) INTO v_renders
    FROM (
      SELECT
        pc.render_id,
        pc.character_name,
        pc.set_name,
        pc.variant,
        pc.total_minted,
        pc.fmv_usd,
        pc.fmv_confidence::text AS fmv_confidence,
        pc.floor_ask,
        ('/api/public/pinnacle-image/' || pc.render_id) AS thumbnail_url
      FROM pinnacle_catalog pc
      JOIN pinnacle_editions pe ON pe.id = v_resolved.pinnacle_edition_id
      WHERE pc.legacy_edition_key = pe.edition_key
    ) r;

    SELECT jsonb_agg(s ORDER BY s.sold_at DESC) INTO v_recent_sales
    FROM (
      SELECT
        ps.serial_number,
        ps.sale_price_usd AS price_usd,
        ps.sold_at,
        ps.source AS marketplace,
        ps.buyer_address,
        ps.seller_address
      FROM pinnacle_sales ps
      WHERE ps.edition_id = v_resolved.pinnacle_edition_id
      ORDER BY ps.sold_at DESC LIMIT 10
    ) s;

    SELECT jsonb_agg(sim) INTO v_similar
    FROM (
      SELECT pe2.id, pe2.character_name, pe2.set_name, pe2.variant_type,
        pe2.edition_type AS tier, pe2.series_year AS series, pe2.thumbnail_url, pe2.mint_count AS circulation_count,
        (SELECT fmv_usd FROM public.get_pinnacle_edition_fmv_collapsed(pe2.id)) AS fmv_usd
      FROM pinnacle_editions pe2
      JOIN pinnacle_editions src ON src.id = v_resolved.pinnacle_edition_id
      WHERE pe2.id <> src.id
        AND (pe2.character_name = src.character_name OR pe2.set_name = src.set_name)
      ORDER BY CASE WHEN pe2.character_name = src.character_name THEN 0 ELSE 1 END,
               pe2.minting_date DESC NULLS LAST
      LIMIT 6
    ) sim;

    RETURN jsonb_build_object(
      'ok', true, 'resolved', to_jsonb(v_resolved),
      'edition', v_edition, 'fmv', v_fmv, 'serial_specific', NULL,
      'recent_sales', COALESCE(v_recent_sales, '[]'::jsonb),
      'similar_editions', COALESCE(v_similar, '[]'::jsonb),
      'renders', COALESCE(v_renders, '[]'::jsonb)
    );
  END IF;

  IF v_resolved.edition_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'input', p_id);
  END IF;

  SELECT jsonb_build_object(
    'id', e.id, 'external_id', e.external_id, 'name', e.name,
    'tier', e.tier, 'series', e.series,
    'player_name', e.player_name, 'team_name', e.team_name,
    'set_name', e.set_name, 'set_id_onchain', e.set_id_onchain,
    'play_id_onchain', e.play_id_onchain, 'play_type', e.play_type,
    'play_category', e.play_category, 'game_date', e.game_date,
    'circulation_count', e.circulation_count,
    'thumbnail_url', e.thumbnail_url, 'video_url', e.video_url,
    'collection_slug', v_resolved.collection_slug
  ) INTO v_edition FROM editions e WHERE e.id = v_resolved.edition_id;

  SELECT jsonb_build_object(
    'fmv_usd', fs.fmv_usd, 'floor_price_usd', fs.floor_price_usd,
    'wap_usd', fs.asp_usd, 'confidence', fs.confidence,
    'sales_count_7d', fs.sales_count_7d, 'sales_count_30d', fs.sales_count_30d,
    'days_since_sale', fs.days_since_sale, 'computed_at', fs.computed_at,
    'algo_version', fs.algo_version, 'top_shot_ask', fs.top_shot_ask,
    'flowty_ask', fs.flowty_ask, 'cross_market_ask', fs.cross_market_ask
  )
  INTO v_fmv FROM fmv_snapshots fs
  WHERE fs.edition_id = v_resolved.edition_id
  ORDER BY fs.computed_at DESC LIMIT 1;

  IF (v_fmv->>'confidence') IN ('LOW', 'MEDIUM')
     AND COALESCE((v_fmv->>'sales_count_30d')::int, 0) >= 10 THEN
    WITH raw AS (
      SELECT s.price_usd::numeric AS p
      FROM sales s
      WHERE s.edition_id = v_resolved.edition_id
        AND s.sold_at >= now() - interval '30 days'
        AND s.price_usd IS NOT NULL
        AND s.price_usd >= 0.50
    ),
    med AS (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY p) AS m FROM raw),
    cleaned AS (
      SELECT r.p FROM raw r CROSS JOIN med
      WHERE med.m IS NULL OR r.p <= med.m * 5
    )
    SELECT CASE WHEN count(*) >= 5 THEN jsonb_build_object(
             'low',  round(percentile_cont(0.10) WITHIN GROUP (ORDER BY p)::numeric, 2),
             'high', round(percentile_cont(0.90) WITHIN GROUP (ORDER BY p)::numeric, 2),
             'n', count(*)
           ) ELSE NULL END
    INTO v_price_band
    FROM cleaned;
  END IF;

  IF v_resolved.kind = 'moment' THEN
    IF v_resolved.moment_id IS NOT NULL THEN
      SELECT jsonb_build_object(
        'serial_number', m.serial_number, 'nft_id', m.nft_id,
        'owner_address', COALESCE(m.owner_address, (
          SELECT w.wallet_address FROM wallet_moments_cache w
          WHERE w.collection_id = m.collection_id AND w.moment_id = m.nft_id
          LIMIT 1
        )),
        'is_listed', m.is_listed,
        'list_price', m.list_price, 'listed_at', m.listed_at,
        'last_sale', COALESCE((
          SELECT jsonb_build_object('price_usd', s.price_usd, 'sold_at', s.sold_at,
                                    'buyer_address', s.buyer_address, 'seller_address', s.seller_address,
                                    'marketplace', s.marketplace)
          FROM sales s WHERE s.moment_id = m.id ORDER BY s.sold_at DESC LIMIT 1
        ), (
          SELECT jsonb_build_object('price_usd', s.price_usd, 'sold_at', s.sold_at,
                                    'buyer_address', s.buyer_address, 'seller_address', s.seller_address,
                                    'marketplace', s.marketplace)
          FROM sales s
          WHERE s.edition_id = v_resolved.edition_id
            AND (s.nft_id = m.nft_id OR (m.serial_number IS NOT NULL AND s.serial_number = m.serial_number))
          ORDER BY s.sold_at DESC LIMIT 1
        ))
      ) INTO v_serial FROM moments m WHERE m.id = v_resolved.moment_id;
    ELSE
      SELECT jsonb_build_object(
        'serial_number', w.serial_number, 'nft_id', w.moment_id,
        'owner_address', w.wallet_address,
        'is_listed', NULL, 'list_price', NULL, 'listed_at', NULL,
        'last_sale', (
          SELECT jsonb_build_object('price_usd', s.price_usd, 'sold_at', s.sold_at,
                                    'buyer_address', s.buyer_address, 'seller_address', s.seller_address,
                                    'marketplace', s.marketplace)
          FROM sales s
          WHERE s.edition_id = v_resolved.edition_id
            AND (s.nft_id = w.moment_id OR (w.serial_number IS NOT NULL AND s.serial_number = w.serial_number))
          ORDER BY s.sold_at DESC LIMIT 1
        )
      ) INTO v_serial
      FROM wallet_moments_cache w
      WHERE w.moment_id = p_id AND w.collection_id = v_resolved.collection_id
      ORDER BY w.last_seen_at DESC NULLS LAST
      LIMIT 1;
    END IF;

    IF v_serial IS NOT NULL THEN
      v_serial_fmv := public.serial_fmv_estimate(
        v_resolved.collection_id,
        (v_serial->>'serial_number')::int,
        (v_edition->>'circulation_count')::int,
        (v_edition->>'tier'),
        (v_fmv->>'fmv_usd')::numeric,
        (v_fmv->>'confidence'),
        (SELECT e.jersey_number FROM public.editions e WHERE e.id = v_resolved.edition_id AND e.jersey_number > 1),
        v_resolved.edition_id
      );
    END IF;
  END IF;

  WITH recent AS (
    SELECT sa.serial_number, sa.price_usd, sa.sold_at, sa.marketplace,
           sa.buyer_address, sa.seller_address, sa.nft_id
    FROM sales sa WHERE sa.edition_id = v_resolved.edition_id
    ORDER BY sa.sold_at DESC LIMIT 10
  ),
  sub_names AS (
    SELECT DISTINCT ON (subedition_id) subedition_id, subedition_name
    FROM editions
    WHERE v_resolved.collection_slug = 'nba_top_shot'
      AND subedition_id IS NOT NULL AND subedition_name IS NOT NULL
    ORDER BY subedition_id
  ),
  enriched AS (
    SELECT r.serial_number, r.price_usd, r.sold_at, r.marketplace,
           r.buyer_address, r.seller_address,
           CASE WHEN v_resolved.collection_slug = 'nba_top_shot' THEN
             COALESCE(
               CASE WHEN tms.subedition_id > 0
                      THEN COALESCE(sn.subedition_name, 'Parallel #' || tms.subedition_id)
                    WHEN tms.subedition_id = 0 THEN 'Standard'
               END,
               NULLIF(e.subedition_name, ''),
               CASE WHEN e.external_id ~ '^[0-9]+:[0-9]+$' THEN 'Standard' END
             )
           END AS parallel
    FROM recent r
    LEFT JOIN editions e ON e.id = v_resolved.edition_id
    LEFT JOIN topshot_moment_subeditions tms
      ON v_resolved.collection_slug = 'nba_top_shot' AND tms.nft_id = r.nft_id
    LEFT JOIN sub_names sn ON sn.subedition_id = tms.subedition_id
  )
  SELECT jsonb_agg(to_jsonb(s.*) ORDER BY s.sold_at DESC) INTO v_recent_sales
  FROM enriched s;

  SELECT jsonb_agg(sim) INTO v_similar
  FROM (
    SELECT e2.id, COALESCE(e2.player_name, e2.team_name, e2.name) AS player_name, e2.set_name, e2.tier, e2.series, e2.external_id, e2.thumbnail_url, e2.circulation_count,
      (SELECT fmv_usd FROM fmv_snapshots WHERE edition_id = e2.id ORDER BY computed_at DESC LIMIT 1) AS fmv_usd
    FROM editions e2
    JOIN editions src ON src.id = v_resolved.edition_id
    WHERE e2.collection_id = src.collection_id AND e2.id <> src.id
      AND e2.thumbnail_url IS NOT NULL
      AND (e2.player_name = src.player_name OR e2.set_name = src.set_name)
    ORDER BY CASE WHEN e2.player_name = src.player_name THEN 0 ELSE 1 END,
             e2.first_minted_at DESC NULLS LAST LIMIT 6) sim;

  RETURN jsonb_build_object(
    'ok', true, 'resolved', to_jsonb(v_resolved),
    'edition', v_edition, 'fmv', v_fmv, 'serial_specific', v_serial,
    'serial_fmv', v_serial_fmv,
    'price_band_30d', v_price_band,
    'recent_sales', COALESCE(v_recent_sales, '[]'::jsonb),
    'similar_editions', COALESCE(v_similar, '[]'::jsonb)
  );
END;
$function$;
