-- 2026-10-21 ~5:40 PM PT (Claude Code cloud; Trevor: "Take care of 204 yourself") — #204, the design
-- half: a Panini set page is keyed on the `sets` ROW (one product's set), not on the set NAME.
--
-- WHY. editions.set_name 'Base Prizms Blue' spans three products (2026 Prizm World Cup 499 editions,
-- 2022-23 Prizm Basketball 97, 2022 Prizm FIFA World Cup 6), so /panini-blockchain/set/base-prizms-blue
-- listed LeBron James in a World Cup set; 20261021195016 made the page SAY so. Measured 10-21 PT: 389 of
-- 1,979 Panini set names span more than one product (33 of them include the 2026 World Cup catalog's own
-- row, 356 do not); each of the 2,693 Panini `sets` rows carries exactly ONE editions.set_name.
--
-- SCHEME. A product's set is addressed by its `sets.external_id` minus 'panini-' — the bridge's own key:
-- 'panini-p1819-base-prizms-blue' -> /set/p1819-base-prizms-blue; product 2332's (the 2026 World Cup
-- catalog) rows carry no product prefix, so the plain 'base-prizms-blue' IS that product's set (no product
-- key collides with a name slug: 0 measured). A slug that matches no `sets` row keeps the name-keyed
-- combined view, which now LINKS each product. Canonical: a product's own key when several products share
-- the name; the name slug when it is the only one (one product, one URL — its key 308s there).
--
-- CHANGES.
--   get_set_detail (PINNED; built from the 20261021195016 body, live md5(prosrc) 6b095b87… = that file,
--     re-read immediately before applying): a Panini slug naming a `sets` row returns that row's header,
--     every stat scoped to editions.set_id, plus set_id / product_name / canonical_slug /
--     related_products (the other products sharing the name, each with its page slug). The combined
--     view's underlying_sets entries now carry {name: PRODUCT name, editions, slug}. Other collections:
--     unchanged (the new keys are null).
--   get_set_editions (unpinned; built LITERALLY from live prosrc md5 585f2cb3… = 20261018182719 plus the
--     20261021145002 play_category/game_date splice): the same resolution, the grid filtered to one set_id.
--   panini_product_set_sales(p_set_id, p_limit) (NEW): panini_set_sales' exact shape and rules, its
--     editions taken from one `sets` row instead of a set name.
--   panini_product_set_pages() (NEW): the product keys that ARE canonical (a name several products
--     share; the 2026 catalog's rows and single-product names already list under the name slug), with
--     edition count + newest edition timestamp, for the sitemap.
--   panini_edition_set_slug(p_edition_external_id) (NEW): the canonical set-page slug of an edition's
--     own product — get_set_detail's own canonical_slug, so the two cannot disagree.
--
-- anon-exec: intentional — unchanged; CREATE OR REPLACE with the same signature keeps the existing grants (postgres + service_role only) (get_set_detail)
-- anon-exec: intentional — unchanged; CREATE OR REPLACE with the same signature keeps the existing grants (postgres + service_role only) (get_set_editions)
-- anon-exec: intentional — REVOKEd from PUBLIC, anon, authenticated; service_role only, as panini_set_sales (panini_product_set_sales)
-- anon-exec: intentional — REVOKEd from PUBLIC, anon, authenticated; service_role only (panini_product_set_pages)
-- anon-exec: intentional — REVOKEd from PUBLIC, anon, authenticated; service_role only (panini_edition_set_slug)
-- REVERT: re-apply get_set_detail from 20261021195016 and get_set_editions from 20261021145002 (its
--   splice of 20261018182719); DROP FUNCTION public.panini_product_set_sales(uuid, integer), public.panini_product_set_pages(),
--   public.panini_edition_set_slug(text). The page
--   falls back to the name-keyed combined view when the new keys are absent.
CREATE OR REPLACE FUNCTION public.get_set_detail(p_collection_id uuid, p_set_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_panini_uuid   CONSTANT uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_set       RECORD;
  v_fmv_total numeric;
  v_floor_total numeric;
  v_fmv_ask_derived numeric;
  v_listed_count int;
  v_editions_with_fmv int;
  v_edition_count int;
  v_collection_slug text;
  v_underlying_set_count int;
  v_underlying_sets jsonb;
  v_pin_circulation bigint;
  v_sid uuid;              -- Panini: the `sets` row a product-scoped slug names (#204)
  v_product_name text;
  v_canonical_slug text;
  v_related jsonb;
  v_variants text[];
BEGIN
  -- 2026-10-21 (#204, design half): a Panini slug that IS a `sets` row's key (its external_id
  -- minus 'panini-') is that PRODUCT's set — 'p1819-base-prizms-blue' is 2022-23 Prizm
  -- Basketball's, and the plain 'base-prizms-blue' is the 2026 World Cup catalog's own row (the
  -- bridge keys product 2332's sets without a product prefix). The header row is built from that
  -- row's editions alone — each Panini `sets` row carries exactly ONE editions.set_name (measured
  -- 0 of 2,693 with two) — so every stat below is scoped to one editions.set_id. Any other slug
  -- keeps the name-keyed sets_summary row: the combined view, which names and links its products.
  IF p_collection_id = v_panini_uuid THEN
    SELECT s.id INTO v_sid
      FROM sets s
     WHERE s.external_id = 'panini-' || p_set_slug
       AND s.collection_id = p_collection_id;
  END IF;

  IF v_sid IS NOT NULL THEN
    -- ⚠ Column for column the TYPES of sets_summary (bigint / smallint / text[]): v_set is one
    -- RECORD read by both branches, and a field whose type differs between calls on one connection
    -- fails the cached plan ("type of parameter N does not match").
    SELECT p_collection_id                                                              AS collection_id,
           p_set_slug::text                                                             AS set_slug,
           min(e.set_name)::text                                                        AS set_name,
           ARRAY[min(e.set_name)]::text[]                                               AS set_name_variants,
           count(*)::bigint                                                             AS edition_count,
           (sum(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL))::bigint AS total_circulation,
           (array_agg(DISTINCT e.tier::text) FILTER (WHERE e.tier IS NOT NULL))::text[] AS tiers_present,
           min(e.series)::smallint                                                      AS min_series,
           max(e.series)::smallint                                                      AS max_series,
           min(e.first_minted_at)::timestamptz                                          AS first_minted_at,
           max(e.updated_at)::timestamptz                                               AS last_updated_at,
           now()                                                                        AS computed_at
      INTO v_set
      FROM editions e
     WHERE e.set_id = v_sid
       AND e.collection_id = p_collection_id;
    -- A `sets` row with no editions is not a page (no name to show, nothing to count).
    IF v_set.set_name IS NULL THEN
      RETURN NULL;
    END IF;
  ELSE
    SELECT * INTO v_set
    FROM sets_summary
    WHERE collection_id = p_collection_id
      AND set_slug = p_set_slug;

    IF v_set IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  -- The per-edition latest-FMV rollup is the only expensive read here. On the
  -- largest sets it can exceed the request statement budget cold and would
  -- otherwise error the whole page (Sentry JAVASCRIPT-NEXTJS-22). Catch that
  -- cancellation and degrade the header stats to NULL (rendered "-") instead of
  -- throwing; normal-sized sets finish in a few ms and never trip this.
  BEGIN
    IF p_collection_id = v_pinnacle_uuid THEN
      -- Render-level (per-pin), matching the get_set_editions grid. Joined by
      -- btrim(set_name) to defuse the catalog leading-space quirk.
      -- Total Mint too (2026-09-27): sets_summary's figure for Pinnacle is ONE
      -- set-level legacy key's mint count, not the set's (163 of 178 sets were
      -- understated, median 4.9x). Summed over the same pins the grid lists, and
      -- NULL — never a partial sum — if any pin's mint count is unknown.
      SELECT
        COUNT(*),
        SUM(pc.fmv_usd)                                  FILTER (WHERE pc.fmv_usd > 0),
        SUM(pc.floor_ask)                                FILTER (WHERE pc.floor_ask > 0),
        COUNT(pc.fmv_usd)                                FILTER (WHERE pc.fmv_usd > 0),
        CASE WHEN COUNT(*) > 0 AND COUNT(*) = COUNT(pc.total_minted) THEN SUM(pc.total_minted) END,
        SUM(pc.fmv_usd)                                  FILTER (WHERE pc.fmv_usd > 0 AND pc.fmv_confidence::text = 'ASK_ONLY'),
        COUNT(*)                                         FILTER (WHERE pc.floor_ask > 0)
      INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv, v_pin_circulation, v_fmv_ask_derived, v_listed_count
      FROM pinnacle_catalog pc
      WHERE btrim(pc.set_name) = ANY (SELECT btrim(x) FROM unnest(v_set.set_name_variants) x);
    ELSE
      SELECT
        COUNT(*),
        SUM(fmv.fmv_usd)                                          FILTER (WHERE fmv.fmv_usd > 0),
        SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd))           FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
        COUNT(fmv.fmv_usd)                                        FILTER (WHERE fmv.fmv_usd > 0)
      INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd
        FROM fmv_snapshots
        WHERE edition_id = e.id
        ORDER BY computed_at DESC
        LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.set_name = ANY(v_set.set_name_variants)
        AND (v_sid IS NULL OR e.set_id = v_sid)
        AND e.thumbnail_url IS NOT NULL;
    END IF;
  EXCEPTION WHEN query_canceled THEN
    -- Rollup blew the request statement budget: return the header with NULL stats
    -- (page shows "-") rather than throwing the whole page away.
    v_edition_count := NULL;
    v_fmv_total := NULL;
    v_floor_total := NULL;
    v_editions_with_fmv := NULL;
    v_pin_circulation := NULL;
    v_fmv_ask_derived := NULL;
    v_listed_count := NULL;
  END;

  -- D20: how many underlying `sets` rows merged into this slug. Complete-by-
  -- construction merge signal (name-identical seasonal repeats included, which
  -- set_name_variants misses). Reads the 914-row `sets` table — trivially cheap.
  -- Pinnacle has no `sets` rows → 0 (page keys the banner on > 1).
  IF p_collection_id = v_panini_uuid THEN
    -- 2026-10-21 (#204): Panini's `sets` rows are PRODUCT-scoped ("<product> · <set>"), so the
    -- name test below matches none of them, and a set name several products share (Base Prizms
    -- Blue: the 2026 World Cup catalog 499 editions, 2022-23 Basketball 97, 2022 World Cup 6)
    -- rendered as ONE set with no banner — LeBron James in a World Cup set. Count and NAME the
    -- products from the editions' own set_id (idx_editions_collection_set_name; ~3 ms).
    -- 2026-10-21 (#204, design half): each product carries its page's slug — its own key when
    -- several products share the name, the name slug when it is the only one (one product, one
    -- URL) — and is labelled by its PRODUCT name (the main catalog's `sets.name` is the bare set
    -- name, so its label is product 2332's). A product page lists the OTHER products as
    -- related_products and reports its own canonical_slug (the page 308s to it).
    v_variants := CASE WHEN v_sid IS NULL THEN v_set.set_name_variants
                       ELSE COALESCE((SELECT ss.set_name_variants FROM sets_summary ss
                                       WHERE ss.collection_id = p_collection_id
                                         AND ss.set_slug = regexp_replace(lower(v_set.set_name), '[^a-z0-9]+', '-', 'g')),
                                     v_set.set_name_variants) END;
    WITH x AS (
      SELECT s.id, s.name::text AS name, substring(s.external_id FROM 8) AS key_slug,
             s.external_id !~ '^panini-p[0-9]+-' AS is_main, count(*) AS n
        FROM editions e
        JOIN sets s ON s.id = e.set_id
       WHERE e.collection_id = p_collection_id
         AND e.set_name = ANY(v_variants)
       GROUP BY s.id, s.name, s.external_id
    ), y AS (
      SELECT x.id, x.n,
             CASE WHEN x.is_main THEN (SELECT pr.name::text FROM panini_products pr WHERE pr.set_id = 2332)
                  ELSE split_part(x.name, ' · ', 1) END                                   AS product,
             CASE WHEN NOT x.is_main AND count(*) OVER () = 1
                  THEN regexp_replace(lower(v_set.set_name), '[^a-z0-9]+', '-', 'g')
                  ELSE x.key_slug END                                                     AS slug
        FROM x
    )
    SELECT count(*),
           jsonb_agg(jsonb_build_object('name', y.product, 'editions', y.n, 'slug', y.slug) ORDER BY y.n DESC, y.product)
             FILTER (WHERE v_sid IS NULL OR y.id <> v_sid),
           max(y.product) FILTER (WHERE y.id = v_sid),
           max(y.slug)    FILTER (WHERE y.id = v_sid)
      INTO v_underlying_set_count, v_underlying_sets, v_product_name, v_canonical_slug
      FROM y;
    IF v_sid IS NOT NULL THEN
      v_related := v_underlying_sets;
      v_underlying_sets := NULL;
      v_underlying_set_count := 1;
    END IF;
  ELSE
    SELECT count(*) INTO v_underlying_set_count
    FROM sets s
    WHERE s.collection_id = p_collection_id
      AND s.name::text = ANY(v_set.set_name_variants)
      -- 2026-10-18 (R58 residual): only sets that HAVE editions count. An editionless
      -- stub (`WNBA Skyline` auto_onchain_254) made /wnba-skyline say "Combined view:
      -- 2 sets share this name" over one real set (1 false + 3 overcounted banners,
      -- Top Shot). idx_editions_set makes this one index probe per candidate row.
      AND EXISTS (SELECT 1 FROM editions e WHERE e.set_id = s.id);
  END IF;

  RETURN jsonb_build_object(
    'collection_id',       v_set.collection_id,
    'collection_slug',     v_collection_slug,
    'set_slug',            v_set.set_slug,
    'set_name',            v_set.set_name,
    'set_name_variants',   v_set.set_name_variants,
    'underlying_set_count', v_underlying_set_count,
    'underlying_sets',     v_underlying_sets,
    'set_id',              v_sid,
    'product_name',        v_product_name,
    'canonical_slug',      v_canonical_slug,
    'related_products',    v_related,
    'edition_count',       v_edition_count,
    'editions_with_fmv',   v_editions_with_fmv,
    'total_circulation',   CASE WHEN p_collection_id = v_pinnacle_uuid THEN v_pin_circulation ELSE v_set.total_circulation END,
    'tiers_present',       v_set.tiers_present,
    'min_series',          v_set.min_series,
    'max_series',          v_set.max_series,
    'first_minted_at',     v_set.first_minted_at,
    'last_updated_at',     v_set.last_updated_at,
    'fmv_total_usd',       v_fmv_total,
    'floor_total_usd',     v_floor_total,
    'fmv_ask_derived_usd', v_fmv_ask_derived,
    'listed_count',        v_listed_count,
    'summary_computed_at', v_set.computed_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_set_editions(p_collection_id uuid, p_set_slug text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_panini_uuid   CONSTANT uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_sid           uuid;
  v_safe_limit    int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_safe_offset   int := GREATEST(COALESCE(p_offset, 0), 0);
  v_variants      text[];
  result          jsonb;
BEGIN
  -- 2026-10-21 (#204, design half): a Panini slug that is a `sets` row's key (external_id minus
  -- 'panini-') lists THAT product's editions only — the same resolution get_set_detail makes, so
  -- the grid and the header count one editions.set_id. Any other slug keeps the name-keyed list.
  IF p_collection_id = v_panini_uuid THEN
    SELECT s.id INTO v_sid
      FROM sets s
     WHERE s.external_id = 'panini-' || p_set_slug
       AND s.collection_id = p_collection_id;
  END IF;

  IF v_sid IS NOT NULL THEN
    v_variants := ARRAY(SELECT DISTINCT e.set_name FROM editions e
                         WHERE e.set_id = v_sid AND e.collection_id = p_collection_id AND e.set_name IS NOT NULL);
    IF cardinality(v_variants) = 0 THEN
      v_variants := NULL;
    END IF;
  ELSE
    SELECT set_name_variants INTO v_variants
    FROM sets_summary
    WHERE collection_id = p_collection_id AND set_slug = p_set_slug;
  END IF;

  IF v_variants IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    WITH ed AS (
      SELECT
        pc.render_id                                       AS route_slug,
        pc.character_name                                  AS player_name,
        pc.character_name || ' (' || pc.variant || ')'     AS name,
        pc.variant                                         AS tier,
        NULL::int                                          AS tier_rank,
        pc.series_name                                     AS series_label,
        pc.total_minted                                    AS circulation_count,
        pc.thumbnail_url,
        pc.fmv_usd,
        pc.floor_ask                                       AS floor_usd,
        pc.fmv_confidence::text                            AS fmv_confidence,
        pc.fmv_computed_at                                 AS fmv_computed_at
      FROM pinnacle_catalog pc
      WHERE btrim(pc.set_name) = ANY (SELECT btrim(x) FROM unnest(v_variants) x)
      ORDER BY pc.character_name, pc.variant
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  ELSE
    WITH pick AS (
      -- PHASE 1: ordering keys only. All three come from `editions`, so this
      -- picks exactly the rows the old single-CTE form would have kept.
      SELECT
        e.id,
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1
          WHEN 'LEGENDARY'  THEN 2
          WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4
          WHEN 'CONTENDER'  THEN 5
          WHEN 'EPIC'       THEN 5
          WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7
          WHEN 'FANDOM'     THEN 8
          WHEN 'COMMON'     THEN 9
          ELSE 99
        END                                                AS tier_rank,
        e.circulation_count,
        e.player_name
      FROM editions e
      WHERE e.collection_id = p_collection_id
        AND e.set_name = ANY(v_variants)
        AND (v_sid IS NULL OR e.set_id = v_sid)
        AND e.thumbnail_url IS NOT NULL
      ORDER BY 2, e.circulation_count NULLS LAST, e.player_name
      LIMIT v_safe_limit OFFSET v_safe_offset
    ),
    ed AS (
      -- PHASE 2: FMV lateral + entity_rep_nft_id, over v_safe_limit rows.
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.player_name,
        e.name,
        e.tier::text                                       AS tier,
        p.tier_rank                                        AS tier_rank,
        public.series_display_label(p_collection_id, e.series::int)                                     AS series_label,
        e.circulation_count,
        e.thumbnail_url,
        public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
        e.video_url,
        e.team_name,
        e.subedition_name,
        e.play_category,
        e.game_date,
        e.play_type,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence,
        fmv.computed_at                                    AS fmv_computed_at
      FROM pick p
      JOIN editions e ON e.id = p.id
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence, computed_at
        FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC
        LIMIT 1
      ) fmv ON true
      ORDER BY p.tier_rank, p.circulation_count NULLS LAST, p.player_name
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  END IF;

  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.panini_product_set_sales(p_set_id uuid, p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH lim AS (
    SELECT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 25) AS n
  ), eds AS (
    SELECT pe.external_id, pe.player_name, pe.set_name
    FROM editions ed
    JOIN panini_editions pe ON pe.external_id = ed.external_id
    WHERE ed.set_id = p_set_id
      AND ed.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
  ), s AS (
    SELECT ps.sku, ps.edition_external_id, ps.sold_at, ps.amount_usd, e.player_name, e.set_name
    FROM panini_sales ps
    JOIN eds e ON e.external_id = ps.edition_external_id
    WHERE ps.amount_usd > 0
  )
  SELECT jsonb_build_object(
    'editions',      (SELECT count(*) FROM eds),
    'editions_read', (SELECT count(*) FROM panini_sales_reads r JOIN eds e ON e.external_id = r.edition_external_id
                      WHERE r.complete_since IS NOT NULL),
    'window_30d',    (SELECT jsonb_build_object(
                        'sales', count(*),
                        'volume_usd', round(coalesce(sum(amount_usd), 0), 2),
                        'median_usd', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_usd::float8)::numeric, 2),
                        'editions_traded', count(DISTINCT edition_external_id))
                      FROM s WHERE sold_at > now() - interval '30 days'),
    'top',    COALESCE((SELECT jsonb_agg(to_jsonb(t.*) ORDER BY t.amount_usd DESC, t.sold_at DESC, t.sku)
                        FROM (SELECT * FROM s ORDER BY amount_usd DESC, sold_at DESC, sku LIMIT (SELECT n FROM lim)) t), '[]'::jsonb),
    'recent', COALESCE((SELECT jsonb_agg(to_jsonb(t.*) ORDER BY t.sold_at DESC, t.sku)
                        FROM (SELECT * FROM s ORDER BY sold_at DESC, sku LIMIT (SELECT n FROM lim)) t), '[]'::jsonb)
  )
$$;


REVOKE ALL ON FUNCTION public.panini_product_set_sales(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_product_set_sales(uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.panini_product_set_pages()
RETURNS TABLE(slug text, editions bigint, last_updated_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- A product is grouped with the others carrying its set NAME exactly as get_set_detail groups
  -- them (by the name slug sets_summary keys on), so "shared" here means what the page says it means.
  WITH p AS (
    SELECT substring(s.external_id FROM 8) AS key_slug,
           s.external_id !~ '^panini-p[0-9]+-' AS is_main,
           regexp_replace(lower(min(e.set_name)), '[^a-z0-9]+', '-', 'g') AS name_slug,
           count(*) AS n,
           max(e.updated_at) AS ts
      FROM sets s
      JOIN editions e ON e.set_id = s.id
     WHERE s.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
       AND e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
     GROUP BY s.id, s.external_id
  ), q AS (
    SELECT p.*, count(*) OVER (PARTITION BY p.name_slug) AS products FROM p
  )
  SELECT q.key_slug, q.n, q.ts
    FROM q
   WHERE NOT q.is_main AND q.products > 1
   ORDER BY q.key_slug
$$;

REVOKE ALL ON FUNCTION public.panini_product_set_pages() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_product_set_pages() TO service_role;

CREATE OR REPLACE FUNCTION public.panini_edition_set_slug(p_edition_external_id text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.get_set_detail('d1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid, substring(s.external_id FROM 8)) ->> 'canonical_slug'
    FROM editions e
    JOIN sets s ON s.id = e.set_id
   WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
     AND e.external_id = p_edition_external_id
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.panini_edition_set_slug(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_edition_set_slug(text) TO service_role;
