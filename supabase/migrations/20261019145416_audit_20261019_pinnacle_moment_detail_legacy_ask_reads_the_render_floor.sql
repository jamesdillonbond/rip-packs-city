-- audit_20261019: Pinnacle ASK-unify — get_moment_detail's legacy-key edition reads the render floor
--
-- Companion to 20261019145210 (get_edition_detail). The 'pinnacle_edition' branch of
-- get_moment_detail returned edition.ask_price = pinnacle_editions.ask_price, frozen since
-- 2026-07-17 (328 rows; the writer pinnacle-listings-reconcile was retired that day and its
-- route deleted 2026-08-21), with ask_source 'pinnacle_direct' and no timestamp, so a reader
-- had no way to tell it was three months old. No rendered surface reads that field today
-- (the trophy picker reads edition.external_id/name and fmv only), so this is a payload
-- honesty fix, not a visible change.
--
-- Now: ask_price = the lowest pinnacle_catalog.floor_ask among the renders bridged to the
-- key (legacy_edition_key = pe.edition_key); ask_source 'pinnacle_catalog', or NULL when no
-- render under the key has a floor. Every other line is unchanged from 20260726016000.
--
-- REVERT: re-apply the get_moment_detail block of
--   supabase/migrations/20260726016000_audit_20260726_serial_fmv_consumers_pooled_edition_id.sql
-- and point its drift-guard registration back at that file.
--
-- anon-exec: unchanged (get_moment_detail) — CREATE OR REPLACE of an existing fn; ACL preserved (no REVOKE here); has_function_privilege anon=false read 2026-10-19 before apply.
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
      'edition_key', pe.edition_key, 'ask_price', cf.floor_ask,
      'ask_source', CASE WHEN cf.floor_ask IS NULL THEN NULL ELSE 'pinnacle_catalog' END,
      'collection_slug', 'disney_pinnacle'
    )
    INTO v_edition
    FROM pinnacle_editions pe
    -- 2026-10-19 ASK-unify: the lowest live render floor under this set-level key,
    -- never the legacy pe.ask_price (frozen since 2026-07-17, no writer).
    LEFT JOIN LATERAL (
      SELECT min(pc.floor_ask) AS floor_ask
      FROM pinnacle_catalog pc
      WHERE pc.legacy_edition_key = pe.edition_key
        AND pc.floor_ask IS NOT NULL
    ) cf ON true
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
