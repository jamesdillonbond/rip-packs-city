-- DB invariant: public.get_moment_detail — the moment/edition detail read behind
-- every /[collection]/moment and /edition page (the platform's highest-traffic
-- read). A regression mis-states a public moment's edition/FMV/serial data, or
-- worse, renders a misleading 30-day PRICE BAND. This pins the standard (Flow)
-- moment path and, above all, the price_band honesty gate.
--
-- Pins:
--   * an unresolvable id, and a resolved row with a NULL edition_id, both return
--     {ok:false, error:'not_found'};
--   * the edition + latest-snapshot FMV envelopes are built for a resolved moment;
--   * price_band_30d is emitted ONLY when confidence is LOW/MEDIUM AND
--     sales_count_30d >= 10 AND at least 5 sales survive the median×5 outlier trim;
--     a HIGH-confidence edition (gate closed) and a thin-sales edition (inner
--     count<5) both yield NULL — no fabricated price range;
--   * serial_specific resolves from the moments row, with owner_address falling
--     back to wallet_moments_cache and last_sale falling back to an edition+serial
--     match when there's no direct moment_id sale;
--   * recent_sales labels a bare int:int Top Shot edition as the 'Standard' parallel;
--   * similar_editions surfaces same-player editions.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260726016000_audit_20260726_serial_fmv_consumers_pooled_edition_id.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- The pinnacle branch references objects we don't fixture (we drive the Flow
-- path); defer body validation so those unreferenced-at-runtime lookups don't
-- need stubs. The embedded DDL is byte-verified against live, so it is valid.
SET LOCAL check_function_bodies = off;

-- ── minimal fixtures (Flow / standard path) ──────────────────────────────────
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, external_id text, name text, tier text, series smallint,
  player_name text, team_name text, set_name text, set_id_onchain int,
  play_id_onchain int, play_type text, play_category text, game_date date,
  circulation_count int, thumbnail_url text, video_url text, collection_id uuid,
  jersey_number smallint, subedition_id smallint, subedition_name text,
  first_minted_at timestamptz);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, fmv_usd numeric, floor_price_usd numeric, asp_usd numeric,
  confidence text, sales_count_7d int, sales_count_30d int, days_since_sale int,
  computed_at timestamptz, algo_version text, top_shot_ask numeric,
  flowty_ask numeric, cross_market_ask numeric);
CREATE TABLE public.sales (
  edition_id uuid, moment_id uuid, nft_id text, serial_number int,
  price_usd numeric, sold_at timestamptz, marketplace text,
  buyer_address text, seller_address text);
CREATE TABLE public.moments (
  id uuid PRIMARY KEY, collection_id uuid, nft_id text, serial_number int,
  owner_address text, is_listed boolean, list_price numeric, listed_at timestamptz);
CREATE TABLE public.wallet_moments_cache (
  collection_id uuid, moment_id text, wallet_address text, serial_number int,
  last_seen_at timestamptz);
CREATE TABLE public.topshot_moment_subeditions (nft_id text, subedition_id int);

-- resolve_moment_id is pinned separately; stub it via a fixture table.
CREATE TABLE public._resolve (
  p text, kind text, edition_id uuid, collection_slug text, collection_id uuid,
  moment_id uuid, pinnacle_edition_id uuid);
CREATE FUNCTION public.resolve_moment_id(p_id text)
 RETURNS TABLE(kind text, edition_id uuid, collection_slug text, collection_id uuid,
   moment_id uuid, pinnacle_edition_id uuid)
 LANGUAGE sql STABLE AS $$
  SELECT kind, edition_id, collection_slug, collection_id, moment_id, pinnacle_edition_id
  FROM public._resolve WHERE p = p_id
$$;
CREATE FUNCTION public.serial_fmv_estimate(p_cid uuid, p_serial int, p_circ int, p_tier text, p_fmv numeric, p_conf text, p_jersey int, p_edition_id uuid)
 RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object('est', p_fmv) $$;

-- >>> BEGIN verbatim get_moment_detail (keep byte-identical to the migration) >>>
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
-- <<< END verbatim get_moment_detail <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set E   '''e1111111-1111-1111-1111-111111111111'''
\set E2  '''e2222222-2222-2222-2222-222222222222'''
\set E3  '''e3333333-3333-3333-3333-333333333333'''
\set ES  '''e9999999-9999-9999-9999-999999999999'''
\set M   '''0aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''

-- Editions: E (LOW, deep sales), E2 (HIGH), E3 (LOW, thin sales), ES (similar, same player).
INSERT INTO public.editions (id, external_id, name, tier, series, player_name, team_name, set_name, circulation_count, thumbnail_url, video_url, collection_id, jersey_number, first_minted_at) VALUES
  (:E::uuid,  '10:20', 'Cool Moment', 'RARE', 4, 'Dame', 'Blazers', 'Base', 100, 'th',  'vid', :TS::uuid, 5, now()-interval '100 days'),
  (:E2::uuid, '11:21', 'High Moment', 'RARE', 4, 'Ant',  'Wolves',  'Base', 100, 'th2', 'v2',  :TS::uuid, 1, now()-interval '90 days'),
  (:E3::uuid, '12:22', 'Thin Moment', 'RARE', 4, 'Book', 'Suns',    'Base', 100, 'th3', 'v3',  :TS::uuid, 1, now()-interval '80 days'),
  (:ES::uuid, '13:23', 'Sim Moment',  'RARE', 4, 'Dame', 'Blazers', 'Base', 100, 'ths', 'vs',  :TS::uuid, 1, now()-interval '70 days');

INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, floor_price_usd, asp_usd, confidence, sales_count_7d, sales_count_30d, days_since_sale, computed_at, algo_version) VALUES
  (:E::uuid,  60, 55, 58, 'LOW',  3, 12, 1, now(), 'v1.7.0'),
  (:E2::uuid, 80, 70, 75, 'HIGH', 5, 15, 1, now(), 'v1.7.0'),
  (:E3::uuid, 40, 35, 38, 'LOW',  1, 12, 3, now(), 'v1.7.0'),
  (:ES::uuid, 45, 40, 42, 'HIGH', 1,  4, 5, now(), 'v1.7.0');

-- E: 11 clustered sales (50..70) + one 10000 outlier (trimmed at median*5) -> band n=11.
INSERT INTO public.sales (edition_id, moment_id, nft_id, serial_number, price_usd, sold_at, marketplace, buyer_address, seller_address)
SELECT :E::uuid, NULL, 'nftE'||g, g, 48 + g*2, now()-interval '5 days', 'topshot', 'b'||g, 's'||g FROM generate_series(1,11) g;
INSERT INTO public.sales (edition_id, moment_id, nft_id, serial_number, price_usd, sold_at, marketplace, buyer_address, seller_address) VALUES
  (:E::uuid, NULL, 'nftE5', 5, 10000, now()-interval '4 days', 'topshot', 'bx', 'sx');  -- serial 5 sale (also serial-fallback source), outlier trimmed
-- E2: 12 sales (HIGH conf -> gate closed regardless)
INSERT INTO public.sales (edition_id, moment_id, nft_id, serial_number, price_usd, sold_at, marketplace, buyer_address, seller_address)
SELECT :E2::uuid, NULL, 'nftF'||g, g, 60 + g, now()-interval '5 days', 'topshot', 'b'||g, 's'||g FROM generate_series(1,12) g;
-- E3: only 3 sales (LOW conf, sc30d says 12, but real cleaned < 5 -> inner guard NULL)
INSERT INTO public.sales (edition_id, moment_id, nft_id, serial_number, price_usd, sold_at, marketplace, buyer_address, seller_address)
SELECT :E3::uuid, NULL, 'nftG'||g, g, 40 + g, now()-interval '5 days', 'topshot', 'b'||g, 's'||g FROM generate_series(1,3) g;

-- moment M on edition E: owner NULL (fallback to wmc), no direct moment_id sale
-- (last_sale falls back to the edition+serial=5 match = the 10000 row).
INSERT INTO public.moments (id, collection_id, nft_id, serial_number, owner_address, is_listed, list_price, listed_at) VALUES
  (:M::uuid, :TS::uuid, 'NFT5', 5, NULL, true, 99, now());
INSERT INTO public.wallet_moments_cache (collection_id, moment_id, wallet_address, serial_number, last_seen_at) VALUES
  (:TS::uuid, 'NFT5', 'OWNER', 5, now());

-- resolve stubs
INSERT INTO public._resolve (p, kind, edition_id, collection_slug, collection_id, moment_id, pinnacle_edition_id) VALUES
  ('MID',      'moment', :E::uuid,  'nba_top_shot', :TS::uuid, :M::uuid, NULL),
  ('MID2',     'edition',:E2::uuid, 'nba_top_shot', :TS::uuid, NULL,     NULL),
  ('MID3',     'edition',:E3::uuid, 'nba_top_shot', :TS::uuid, NULL,     NULL),
  ('MID_NULL', 'moment', NULL,      'nba_top_shot', :TS::uuid, NULL,     NULL);

-- ── 1. not_found: unresolved id, and resolved-with-null-edition ──────────────
SELECT _assert_eq((public.get_moment_detail('no-such') ->> 'error'), 'not_found', 'unresolved id -> not_found');
SELECT _assert_eq((public.get_moment_detail('no-such') ->> 'ok'), 'false', 'unresolved id -> ok:false');
SELECT _assert_eq((public.get_moment_detail('MID_NULL') ->> 'error'), 'not_found', 'resolved but NULL edition_id -> not_found');

-- ── 2. edition + fmv envelopes ───────────────────────────────────────────────
SELECT _assert_eq((public.get_moment_detail('MID') ->> 'ok'), 'true', 'MID -> ok:true');
SELECT _assert_eq((public.get_moment_detail('MID') -> 'edition' ->> 'name'), 'Cool Moment', 'edition name');
SELECT _assert_eq((public.get_moment_detail('MID') -> 'edition' ->> 'tier'), 'RARE', 'edition tier');
SELECT _assert_eq((public.get_moment_detail('MID') -> 'fmv' ->> 'fmv_usd'), '60', 'fmv from latest snapshot');
SELECT _assert_eq((public.get_moment_detail('MID') -> 'fmv' ->> 'confidence'), 'LOW', 'fmv confidence');

-- ── 3. price_band_30d gate ───────────────────────────────────────────────────
-- OPEN: LOW conf + sc30d>=10 + >=5 cleaned -> band with n = 11 (outlier trimmed).
SELECT _assert(public.get_moment_detail('MID') -> 'price_band_30d' IS NOT NULL AND public.get_moment_detail('MID') -> 'price_band_30d' <> 'null'::jsonb, 'price_band emitted for LOW conf + deep sales');
SELECT _assert_eq((public.get_moment_detail('MID') -> 'price_band_30d' ->> 'n'), '11', 'price_band trims the 10000 outlier (n=11)');
-- CLOSED (confidence): HIGH conf -> NULL even with deep sales.
SELECT _assert_eq((public.get_moment_detail('MID2') ->> 'price_band_30d'), NULL, 'HIGH confidence -> no price_band');
-- CLOSED (thin): LOW conf, sc30d=12, but only 3 real sales (<5 cleaned) -> NULL.
SELECT _assert_eq((public.get_moment_detail('MID3') ->> 'price_band_30d'), NULL, 'thin real sales -> no price_band (inner count<5)');

-- ── 4. serial_specific: owner fallback + last_sale edition/serial fallback ────
SELECT _assert_eq((public.get_moment_detail('MID') -> 'serial_specific' ->> 'serial_number'), '5', 'serial number');
SELECT _assert_eq((public.get_moment_detail('MID') -> 'serial_specific' ->> 'owner_address'), 'OWNER', 'owner_address falls back to wmc when moments.owner_address is NULL');
SELECT _assert_eq((public.get_moment_detail('MID') -> 'serial_specific' -> 'last_sale' ->> 'price_usd'), '10000', 'last_sale falls back to edition+serial match');

-- ── 5. recent_sales parallel label = Standard for int:int external_id ────────
SELECT _assert_eq((public.get_moment_detail('MID') -> 'recent_sales' -> 0 ->> 'parallel'), 'Standard', 'bare int:int TS edition labelled Standard parallel');

-- ── 6. similar_editions: same-player ES present ──────────────────────────────
SELECT _assert(public.get_moment_detail('MID') -> 'similar_editions' <> '[]'::jsonb, 'similar_editions non-empty (same player Dame)');

SELECT '✓ get_moment_detail: all assertions passed' AS result;

ROLLBACK;
