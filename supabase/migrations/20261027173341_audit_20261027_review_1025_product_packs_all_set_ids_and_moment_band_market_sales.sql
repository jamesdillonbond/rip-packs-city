-- audit_20261027 — review of the 10-25 Panini / moment-detail commits: two defects, one migration (one PGRST002 window).
--
-- (1) refresh_panini_product_rollup: product_set_ids held only the set ids that already had a catalogued edition
--     (agg.ids_with_editions). Its one reader is the product page's Packs section (fetchPaniniProductPacks), and
--     Panini packs are walked separately from editions (an edition enters the catalog when a card is listed), so a
--     wave with packs on sale but no listed card yet was dropped. Live 2026-10-27 ~10:40 AM PT: 18 pack types on sale
--     missing from three product pages — 2023 Panini NFT Spectra Football (14 types, set 1934), 2022-23 Best of The
--     NBA (3, set 1800), 2025 Best of The NFL (1, set 2269). Now every set id in the product's name group (grp.ids).
--     Base verified: md5(prosrc) = 3a02f569cdfc527af96725044d26d130 = the body in 20261026013714. One-token edit.
-- (2) get_moment_detail: price_band_30d read `sales` (buyback purchases included) while its gate and the line above
--     it count `sales_market` (buybacks excluded, 20261025215633). The band's raw CTE now reads sales_market.
--     Base verified: md5(prosrc) = 22600cc3997ad8dc3f7ef485d2540631 = the body in 20261025215633. One-token edit.
--     Pin: supabase/tests/get_moment_detail.sql (re-pointed here, + a discriminating buyback-in-band case).
--
-- anon-exec: unchanged (refresh_panini_product_rollup) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- anon-exec: unchanged (get_moment_detail) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
--
-- Revert: re-apply the function blocks of 20261026013714 (rollup) and 20261025215633 (moment detail), then
--   SELECT public.refresh_panini_product_rollup();

CREATE OR REPLACE FUNCTION public.refresh_panini_product_rollup()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
  v_gone    integer;
BEGIN
  WITH pk AS MATERIALIZED (
    -- A Panini product NAME spans several set ids (drops/waves: "2023-24 Panini NFT Best of The NBA" is 12).
    -- The page grain is the name; an unnamed product keeps its own id.
    SELECT p.set_id, COALESCE(NULLIF(btrim(p.name), ''), 'Panini product ' || p.set_id) AS name_key,
           COALESCE(p.sport, p.last_grid_sport) AS sport
      FROM public.panini_products p
  ), grp AS (
    SELECT name_key, min(set_id) AS key_id, array_agg(set_id ORDER BY set_id) AS ids,
           initcap(lower(min(sport))) AS sport
      FROM pk GROUP BY name_key
  ), b AS MATERIALIZED (
    SELECT g.key_id, e.product_set_id, e.external_id, e.player_name, e.set_name, e.parallel, e.mint_cap, e.thumbnail_url,
           mb.fmv_usd, mb.low_ask_usd
      FROM public.panini_editions e
      JOIN pk ON pk.set_id = e.product_set_id
      JOIN grp g ON g.name_key = pk.name_key
      LEFT JOIN public.panini_market_board mb ON mb.external_id = e.external_id
  ), s90 AS MATERIALIZED (
    SELECT b.key_id, b.external_id, b.player_name, b.parallel, s.sku, s.amount_usd, s.sold_at
      FROM public.panini_sales s
      JOIN b ON b.external_id = s.edition_external_id
     WHERE s.sold_at > now() - interval '90 days'
  ), s30 AS (
    SELECT key_id, count(*)::int AS n, sum(amount_usd) AS vol,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_usd) AS med, max(sold_at) AS newest
      FROM s90 WHERE sold_at > now() - interval '30 days'
     GROUP BY 1
  ), top_s AS (
    SELECT key_id,
           jsonb_agg(jsonb_build_object('external_id', external_id, 'player_name', player_name, 'parallel', parallel,
                                        'sku', sku, 'amount_usd', amount_usd, 'sold_at', sold_at)
                     ORDER BY amount_usd DESC, sold_at DESC) AS j
      FROM (SELECT s90.*, row_number() OVER (PARTITION BY key_id ORDER BY amount_usd DESC, sold_at DESC) AS rn FROM s90) x
     WHERE rn <= 8
     GROUP BY 1
  ), top_e AS (
    SELECT key_id,
           jsonb_agg(jsonb_build_object('external_id', external_id, 'player_name', player_name, 'parallel', parallel,
                                        'set_name', set_name, 'mint_cap', mint_cap, 'thumbnail_url', thumbnail_url,
                                        'fmv_usd', fmv_usd, 'low_ask_usd', low_ask_usd)
                     ORDER BY fmv_usd DESC, external_id) AS j
      FROM (SELECT b.*, row_number() OVER (PARTITION BY key_id ORDER BY fmv_usd DESC, external_id) AS rn
              FROM b WHERE fmv_usd IS NOT NULL) x
     WHERE rn <= 12
     GROUP BY 1
  ), sets_g AS (
    -- One row per `sets` row. `slug` is the URL get_set_detail treats as canonical (#204 rule, 20261025221903):
    -- a set name carried by exactly ONE `sets` row outside the World Cup catalog (2332) canonicalises to the
    -- plain slugified name; otherwise the product-scoped key (external_id minus 'panini-').
    SELECT b.key_id, b.product_set_id, st.external_id AS set_ext, min(b.set_name) AS set_name,
           count(*)::int AS editions, count(b.low_ask_usd)::int AS listed,
           sum(b.fmv_usd) AS fmv_total, min(b.low_ask_usd) AS cheapest_ask
      FROM b
      JOIN public.editions ed ON ed.external_id = b.external_id
                             AND ed.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
      JOIN public.sets st ON st.id = ed.set_id
     GROUP BY 1, 2, 3
  ), sets_c AS (
    SELECT g.*,
           CASE WHEN g.product_set_id <> 2332 AND count(*) OVER (PARTITION BY g.set_name) = 1
                THEN regexp_replace(lower(g.set_name), '[^a-z0-9]+', '-', 'g')
                ELSE substring(g.set_ext FROM 8) END AS set_slug
      FROM sets_g g
  ), sets_j AS (
    SELECT key_id, count(*)::int AS n,
           jsonb_agg(jsonb_build_object('slug', set_slug, 'name', set_name, 'editions', editions, 'listed', listed,
                                        'fmv_total_usd', fmv_total, 'cheapest_ask_usd', cheapest_ask)
                     ORDER BY editions DESC, set_slug) AS j
      FROM sets_c GROUP BY 1
  ), agg AS (
    SELECT b.key_id,
           count(*)::int AS editions,
           count(DISTINCT b.player_name)::int AS players,
           count(b.fmv_usd)::int AS priced,
           sum(b.fmv_usd) AS fmv_total,
           count(b.low_ask_usd)::int AS listed,
           min(b.low_ask_usd) AS cheapest,
           array_agg(DISTINCT b.product_set_id ORDER BY b.product_set_id) AS ids_with_editions
      FROM b GROUP BY 1
  )
  INSERT INTO public.panini_product_rollup AS r
    (product_set_id, product_set_ids, name, slug, sport, editions, players, sets, priced_editions, fmv_total_usd,
     listed_editions, cheapest_ask_usd, sales_30d, sales_30d_volume_usd, sales_30d_median_usd, newest_sale_at,
     top_editions, top_sales_90d, sets_list, computed_at)
  SELECT g.key_id,
         g.ids,  -- every set id under this product NAME, not only the ids that already have an edition (packs are walked separately)
         g.name_key,
         COALESCE(NULLIF(btrim(regexp_replace(lower(g.name_key), '[^a-z0-9]+', '-', 'g'), '-'), ''), 'panini-product-' || g.key_id),
         g.sport,
         a.editions, a.players, COALESCE(sj.n, 0), a.priced, a.fmv_total, a.listed, a.cheapest,
         COALESCE(s30.n, 0), s30.vol, s30.med, s30.newest,
         COALESCE(te.j, '[]'::jsonb), COALESCE(ts.j, '[]'::jsonb), COALESCE(sj.j, '[]'::jsonb),
         v_started
    FROM agg a
    JOIN grp g ON g.key_id = a.key_id
    LEFT JOIN s30    ON s30.key_id = a.key_id
    LEFT JOIN top_e te ON te.key_id = a.key_id
    LEFT JOIN top_s ts ON ts.key_id = a.key_id
    LEFT JOIN sets_j sj ON sj.key_id = a.key_id
  ON CONFLICT (product_set_id) DO UPDATE SET
    product_set_ids = EXCLUDED.product_set_ids,
    name = EXCLUDED.name, slug = EXCLUDED.slug, sport = EXCLUDED.sport, editions = EXCLUDED.editions,
    players = EXCLUDED.players, sets = EXCLUDED.sets, priced_editions = EXCLUDED.priced_editions,
    fmv_total_usd = EXCLUDED.fmv_total_usd, listed_editions = EXCLUDED.listed_editions,
    cheapest_ask_usd = EXCLUDED.cheapest_ask_usd, sales_30d = EXCLUDED.sales_30d,
    sales_30d_volume_usd = EXCLUDED.sales_30d_volume_usd, sales_30d_median_usd = EXCLUDED.sales_30d_median_usd,
    newest_sale_at = EXCLUDED.newest_sale_at, top_editions = EXCLUDED.top_editions,
    top_sales_90d = EXCLUDED.top_sales_90d, sets_list = EXCLUDED.sets_list, computed_at = EXCLUDED.computed_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Supersede without deleting: every row one run writes carries the same computed_at (one statement), and the
  -- readers return only rows from the newest run — so a product (or a set id folded into a name group) stops resolving.
  SELECT count(*)::int INTO v_gone FROM public.panini_product_rollup WHERE computed_at < v_started;

  PERFORM public.log_pipeline_run('panini-product-rollup', v_started, v_rows, v_rows, v_gone, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'rollup wrote no rows' END,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'stale_rows_kept', v_gone, 'grain', 'product_name'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-product-rollup', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

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
      -- 2026-10-27: sales_market, not sales — the gate above (sales_count_30d) and the "N market sales" line
      -- count market sales only, so a buyback purchase must not widen the band or raise its n.
      SELECT s.price_usd::numeric AS p
      FROM sales_market s
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
           -- 2026-10-25: a purchase by the collection's own buyback wallet. The sales
           -- count and FMV read sales_market, which excludes these; Recent activity
           -- lists them, so each row says which it is.
           EXISTS (SELECT 1 FROM buyback_wallets b
                   WHERE b.collection_id = v_resolved.collection_id
                     AND b.wallet_address = r.buyer_address::text) AS buyback,
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

COMMENT ON TABLE public.panini_product_rollup IS
  'One row per Panini product NAME (keyed on its lowest panini_products.set_id; product_set_ids = EVERY set id under that name, editions or not — the product page reads packs by them, audit_20261027) for /panini-blockchain/product/<name-slug>. Listing-gated counts (editions SEEN); sales ON RECORD (lagged). Only rows from the newest run (computed_at = max) are current. Rebuilt hourly by refresh_panini_product_rollup(). audit_20261025.';

SELECT public.refresh_panini_product_rollup();
