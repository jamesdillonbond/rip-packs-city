-- 2026-10-25 (PT) — a "Recent Low" above 3x FMV is an old ask, not a recent low: the
-- Recent-Low Totals stop summing it.
--
-- WHY. Production HTML sweep, 10-25 ~2:50 PM PT: /nba-top-shot/set/2025-rookie-ultimates read
-- "Recent-Low Total $79,070" beside "FMV Total $21,650". $55,300 of the gap is one /1 —
-- Jeremiah Fears (220:7651): fmv_usd $1,700 (its last sale), floor_price_usd $57,000, carried
-- forward by apply_fmv_thin_sales_guard from an older snapshot. floor_price_usd means "lowest
-- recent sale or ask" (#143); an ask 33x the price the edition sells for is neither. Same shape,
-- smaller: ~200 All Day `_salescap` rows (#208 capped fmv_usd to recent sales, not the floor
-- field), ~$8.5k in all. The header totals are SUM(COALESCE(floor_price_usd, fmv_usd)).
--
-- WHAT. public.recent_low_usd(floor, fmv): the floor when it is > 0 and at most 3x FMV (or FMV is
-- unknown), else NULL — the same 3x bound the live-ask readers use (lib/asks/edition-live-ask.ts).
-- The six SUM / MIN sites of the non-Pinnacle branches call it, so an out-of-band floor
-- contributes FMV instead: get_player_detail, get_set_detail, get_series_detail (live path) +
-- refresh_series_detail_rollup (its fast path), get_team_detail, get_team_sets (cheapest entry).
-- Pinnacle branches (live render asks, their own rule) are untouched. The STORED floor_price_usd
-- is untouched on purpose: fmv_apply_thin_sale_haircut prices from it (floor x 0.75).
-- Everything else in each body is byte-identical; signatures, SECURITY DEFINER, search_path,
-- statement_timeout and ACLs unchanged (CREATE OR REPLACE).
-- anon-exec: intentional — revoked (recent_low_usd); only the SECURITY DEFINER readers above (owner postgres) call it.
-- anon-exec: unchanged (get_player_detail, get_set_detail, get_series_detail, refresh_series_detail_rollup, get_team_detail, get_team_sets) — CREATE OR REPLACE of existing fns; ACLs preserved.
--
-- Revert: re-apply each body from its previous migration (the md5 guard below names the base)
-- and repoint the pins; DROP FUNCTION public.recent_low_usd(numeric, numeric).

-- PART A of 3 (get_set_detail, get_player_detail; creates recent_low_usd). Split only to keep each apply small.
-- Parts B (get_series_detail + refresh_series_detail_rollup) and C (get_team_detail, get_team_sets) were
-- not applied on 10-25: the MCP apply for B stopped on an unanswered confirmation prompt. Their sites still
-- sum the raw floor until they land as their own migrations.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_set_detail(uuid,text)'::regprocedure) IS DISTINCT FROM 'a49c307f3e31d479ca6418283c82fa42' THEN
    RAISE EXCEPTION 'get_set_detail changed since the splice base -- re-splice';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_player_detail(uuid,text)'::regprocedure) IS DISTINCT FROM '7844cb02e28d9e555d5aefc212abc757' THEN
    RAISE EXCEPTION 'get_player_detail changed since the splice base -- re-splice';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.recent_low_usd(p_floor numeric, p_fmv numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE
           WHEN p_floor > 0 AND (p_fmv IS NULL OR p_fmv <= 0 OR p_floor <= 3 * p_fmv) THEN p_floor
         END
$function$;
REVOKE EXECUTE ON FUNCTION public.recent_low_usd(numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recent_low_usd(numeric, numeric) TO postgres, service_role;

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
        SUM(COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd))           FILTER (WHERE COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd) > 0),
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

CREATE OR REPLACE FUNCTION public.get_player_detail(p_collection_id uuid, p_player_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid    CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_player           RECORD;
  v_collection_slug  text;
  v_edition_count    int;
  v_total_circulation int;
  v_fmv_total        numeric;
  v_floor_total      numeric;
  v_fmv_ask_derived  numeric;
  v_listed_count     int;
  v_first_minted     timestamptz;
  v_last_minted      timestamptz;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  WITH cand AS (
    SELECT p.*,
      (SELECT count(*) FROM editions e
         WHERE e.collection_id = p_collection_id
           AND (e.player_id = p.id OR (e.player_name = p.name AND NOT public.edition_player_is_other_person(e.player_id, p.id)))
           AND e.team_name IS NOT DISTINCT FROM p.team) AS team_edition_count
    FROM players p
    WHERE p.collection_id = p_collection_id
      AND (regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
           OR regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = p_player_slug)
  ),
  recent AS (
    SELECT e.team_name, e.game_date
    FROM editions e
    WHERE e.collection_id = p_collection_id
      AND e.player_name = (SELECT min(name) FROM cand)
      AND e.team_name IS NOT NULL
      AND e.game_date IS NOT NULL
    ORDER BY e.game_date DESC
    LIMIT 1
  ),
  horizon AS (
    SELECT max(game_date) AS max_gd
    FROM editions
    WHERE collection_id = p_collection_id
      AND game_date IS NOT NULL
  )
  SELECT c.* INTO v_player
  FROM cand c
  LEFT JOIN recent r ON true
  CROSS JOIN horizon h
  ORDER BY (CASE WHEN r.team_name IS NOT NULL
                  AND r.game_date >= h.max_gd - interval '18 months'
                  AND c.team = r.team_name
                 THEN 1 ELSE 0 END) DESC,
           c.team_edition_count DESC NULLS LAST,
           (c.is_active IS TRUE) DESC,
           (c.headshot_url IS NOT NULL) DESC,
           c.id
  LIMIT 1;

  IF v_player IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_collection_id = v_pinnacle_uuid AND EXISTS (
       SELECT 1 FROM pinnacle_catalog pc
       WHERE (EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(v_player.name)))
             OR (cardinality(pc.characters) > 1
                 AND lower(btrim(v_player.name)) IN (lower(array_to_string(pc.characters, ' & ')),
                                                     lower(array_to_string(pc.characters, ' ')))))
     ) THEN
    -- 2026-09-26: the same render catalog get_player_editions lists, so the
    -- header counts the pins the grid shows. Minting dates stay from
    -- pinnacle_editions (the catalog carries none) and are NULL where it has none.
    SELECT
      COUNT(*),
      SUM(pc.total_minted) FILTER (WHERE pc.total_minted IS NOT NULL),
      SUM(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0),
      SUM(pc.floor_ask)    FILTER (WHERE pc.floor_ask > 0),
      SUM(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0 AND pc.fmv_confidence::text = 'ASK_ONLY'),
      COUNT(*)             FILTER (WHERE pc.floor_ask > 0)
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_fmv_ask_derived, v_listed_count
    FROM pinnacle_catalog pc
    WHERE (EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(v_player.name)))
             OR (cardinality(pc.characters) > 1
                 AND lower(btrim(v_player.name)) IN (lower(array_to_string(pc.characters, ' & ')),
                                                     lower(array_to_string(pc.characters, ' ')))));
    -- 2026-09-27: dates only when EVERY row carries one. pinnacle_editions has a
    -- minting_date on 83 of 594 rows, so a MIN/MAX over the dated few published a
    -- span as fact (Mickey Mouse: "first minted" = "last minted" from 1 of 24
    -- rows, while his pins span 2023–2026). NULL hides the line.
    SELECT CASE WHEN COUNT(*) > 0 AND COUNT(*) = COUNT(pe.minting_date) THEN MIN(pe.minting_date) END,
           CASE WHEN COUNT(*) > 0 AND COUNT(*) = COUNT(pe.minting_date) THEN MAX(pe.minting_date) END
    INTO v_first_minted, v_last_minted
    FROM pinnacle_editions pe
    WHERE pe.character_name = v_player.name;
  ELSIF p_collection_id = v_pinnacle_uuid THEN
    SELECT
      COUNT(*),
      SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
      SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0),
      CASE WHEN COUNT(*) = COUNT(pe.minting_date) THEN MIN(pe.minting_date) END,
      CASE WHEN COUNT(*) = COUNT(pe.minting_date) THEN MAX(pe.minting_date) END
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_first_minted, v_last_minted
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.character_name = v_player.name;
  ELSE
    SELECT
      COUNT(*),
      SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd)) FILTER (WHERE COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd) > 0),
      MIN(e.first_minted_at),
      MAX(e.first_minted_at)
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_first_minted, v_last_minted
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND (e.player_id = v_player.id OR (e.player_name = v_player.name AND NOT public.edition_player_is_other_person(e.player_id, v_player.id)));
  END IF;

  RETURN jsonb_build_object(
    'id',                v_player.id,
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'player_slug',       p_player_slug,
    'external_id',       v_player.external_id,
    'name',              v_player.name,
    'first_name',        v_player.first_name,
    'last_name',         v_player.last_name,
    'team',              v_player.team,
    'team_slug',         CASE WHEN v_player.team IS NULL THEN NULL
                              ELSE regexp_replace(lower(trim(v_player.team)), '[^a-z0-9]+', '-', 'g') END,
    'jersey_number',     v_player.jersey_number,
    'position',          v_player.position,
    'player_tier',       v_player.player_tier::text,
    'is_active',         v_player.is_active,
    'headshot_url',      v_player.headshot_url,
    'is_character',      p_collection_id = v_pinnacle_uuid,
    'edition_count',     v_edition_count,
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'fmv_ask_derived_usd', v_fmv_ask_derived,
    'listed_count',      v_listed_count,
    'first_minted_at',   v_first_minted,
    'last_minted_at',    v_last_minted
  );
END;
$function$;
