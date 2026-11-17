-- audit_20261114_entity_total_mint_only_when_complete
--
-- WHY (Claude Code cloud, 2026-11-14 ~8:40 PM PT; the same expression as get_player_detail, 20261115043933,
-- found by grepping the DB for it). Five entity reads published "Total Mint" as SUM(x) FILTER (WHERE x IS
-- NOT NULL): a sum over the editions / pins whose count is KNOWN, presented as the total. Live: 280 Candy
-- editions carry no circulation (223 sets, 26 teams), pinnacle_editions 157 of 641 carry no mint_count (the
-- legacy franchise / roster branches). Each total is now NULL (rendered "—") unless every row carries one;
-- where a LEFT JOIN / GROUP BY can add an all-NULL row the count is over the joined key (count(e.id),
-- count(pc.render_id), count(pe.id), count(te.id)), never count(*).
--   get_series_detail (live path, Pinnacle + sports) · refresh_series_detail_rollup (both arms) ·
--   get_set_detail (the set_id product path; the name path reads sets_summary, fixed in the companion
--   migration) · get_team_detail (catalog, legacy and sports arms) · get_team_players (all three rosters).
--
-- WHAT. CREATE OR REPLACE of each live body (md5-guarded; each byte-equal to its pinned migration) with
-- exact replacements only. Headers, SECURITY, search_path and statement_timeout unchanged.
--
-- anon-exec: unchanged (get_series_detail, refresh_series_detail_rollup, get_set_detail, get_team_detail, get_team_players) — CREATE OR REPLACE of existing fns; ACLs preserved.
--
-- APPLIED AS (2026-11-14 ~8:46 PM PT from the clock, version 20261115044647): an md5-asserted in-database splice — each
-- live body read by pg_get_functiondef, the exact replacements below applied with an anchor-count check of 1,
-- EXECUTEd, then the resulting prosrc md5 asserted. Rehearsed first on a scratch local Postgres. This file
-- carries the RESULTING full bodies (what the drift guard pins), so replaying it from the previous state
-- yields the same prosrc: get_series_detail 3b36244f30046ac9be514d879b11793e, refresh_series_detail_rollup cd5a65debd275b1755094652ac528058, get_set_detail 89d67b88b6533358b355d29b9e5c00ca, get_team_detail 8747a813515b054e76c032a88ce03fcb, get_team_players 20a6999930b094dea86615a8ac59d2ac.
--
-- REVERT: re-apply each function's block from its previous pinned migration (20261025235853 /
-- 20261026013559 / 20261025221903 / 20261026003337), then refresh the series rollup.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'get_series_detail' AND pronamespace = 'public'::regnamespace) IS DISTINCT FROM '0fae1eaa37426d747f2683b5c1f9dcde' THEN
    RAISE EXCEPTION 'get_series_detail changed since the splice base -- re-read and re-splice';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'refresh_series_detail_rollup' AND pronamespace = 'public'::regnamespace) IS DISTINCT FROM 'edd86ae71061cba2080a86234f582c6e' THEN
    RAISE EXCEPTION 'refresh_series_detail_rollup changed since the splice base -- re-read and re-splice';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'get_set_detail' AND pronamespace = 'public'::regnamespace) IS DISTINCT FROM '638c233a16505fe20df33f03c57ed22a' THEN
    RAISE EXCEPTION 'get_set_detail changed since the splice base -- re-read and re-splice';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'get_team_detail' AND pronamespace = 'public'::regnamespace) IS DISTINCT FROM 'bab80e0743e80720eaaef37f59572e9c' THEN
    RAISE EXCEPTION 'get_team_detail changed since the splice base -- re-read and re-splice';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'get_team_players' AND pronamespace = 'public'::regnamespace) IS DISTINCT FROM 'deeb49862ea629c986c06e357150f3db' THEN
    RAISE EXCEPTION 'get_team_players changed since the splice base -- re-read and re-splice';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_series_detail(p_collection_id uuid, p_series_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid     CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_series            RECORD;
  v_collection_slug   text;
  v_edition_count     int;
  v_total_circulation bigint;
  v_fmv_total         numeric;
  v_floor_total       numeric;
  v_fmv_ask_derived   numeric;
  v_listed_count      int;
  v_set_count         int;
  v_player_count      int;
  v_computed_at       timestamptz;
  v_pinnacle_year     int;
  v_hit               boolean := false;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  SELECT * INTO v_series
  FROM collection_series
  WHERE collection_id = p_collection_id
    AND regexp_replace(lower(trim(display_label)), '[^a-z0-9]+', '-', 'g') = p_series_slug
  LIMIT 1;

  IF v_series IS NULL THEN RETURN NULL; END IF;

  -- FAST PATH: the rollup refreshed by jobid 357 `rpc-series-detail-rollup`.
  SELECT true, r.edition_count, r.total_circulation, r.fmv_total_usd,
         r.floor_total_usd, r.set_count, r.player_count, r.computed_at,
         r.fmv_ask_derived_usd, r.listed_count
  INTO v_hit, v_edition_count, v_total_circulation, v_fmv_total,
       v_floor_total, v_set_count, v_player_count, v_computed_at,
       v_fmv_ask_derived, v_listed_count
  FROM series_detail_rollup r
  WHERE r.collection_id = p_collection_id
    AND r.series_number = v_series.series_number;

  IF NOT COALESCE(v_hit, false) THEN
    -- No rollup row yet. Correctness over latency: compute it live rather than
    -- report zeros. v_computed_at stays NULL, which is the honest answer for a
    -- value that did not come from the rollup.
    IF p_collection_id = v_pinnacle_uuid THEN
      BEGIN
        v_pinnacle_year := v_series.season::int;
      EXCEPTION WHEN invalid_text_representation THEN
        v_pinnacle_year := NULL;
      END;

      IF v_pinnacle_year IS NOT NULL THEN
        -- 2026-09-26: from the render catalog, as refresh_series_detail_rollup.
        SELECT
          COUNT(*),
          CASE WHEN COUNT(*) = COUNT(pc.total_minted) THEN SUM(pc.total_minted) END,
          SUM(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0),
          SUM(pc.floor_ask)    FILTER (WHERE pc.floor_ask > 0),
          COUNT(DISTINCT btrim(pc.set_name)),
          COUNT(DISTINCT btrim(pc.characters[1])),
          SUM(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0 AND pc.fmv_confidence::text = 'ASK_ONLY'),
          COUNT(*)             FILTER (WHERE pc.floor_ask > 0)
        INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_set_count, v_player_count, v_fmv_ask_derived, v_listed_count
        FROM pinnacle_catalog pc
        WHERE pc.series_name = v_pinnacle_year::text;
      END IF;
    ELSE
      SELECT
        COUNT(*),
        CASE WHEN COUNT(e.id) = COUNT(e.circulation_count) THEN SUM(e.circulation_count) END,
        SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
        SUM(COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd)) FILTER (WHERE COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd) > 0),
        COUNT(DISTINCT e.set_name),
        COUNT(DISTINCT COALESCE(e.player_id::text, e.player_name))
      INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_set_count, v_player_count
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'series_slug',       p_series_slug,
    'series_number',     v_series.series_number,
    'display_label',     v_series.display_label,
    'season',            v_series.season,
    'edition_count',     COALESCE(v_edition_count, 0),
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'fmv_ask_derived_usd', v_fmv_ask_derived,
    'listed_count',      v_listed_count,
    'set_count',         COALESCE(v_set_count, 0),
    'player_count',      COALESCE(v_player_count, 0),
    'stats_computed_at', v_computed_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_series_detail_rollup(p_max_seconds integer DEFAULT 240)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pinnacle CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_started  timestamptz := clock_timestamp();
  v_coll     record;
  v_t0       timestamptz;
  v_ms       int;
  v_rows     int;
  v_done     int := 0;
  v_written  int := 0;
  v_skipped  int := 0;
  v_detail   jsonb := '[]'::jsonb;
  v_fmv      jsonb;
  v_fmv_err  text := NULL;
  v_ok       boolean := true;
BEGIN
  -- Must run before the loop reads the table. Isolated so it cannot take the
  -- job down: a stale edition_fmv_current still produces a correct-shaped
  -- rollup, one tick behind.
  BEGIN
    v_fmv := public.refresh_edition_fmv_current();
  -- query_canceled named (2026-09-28): a statement_timeout kill (57014) escapes
  -- WHEN OTHERS, which took the whole rollup down instead of isolating this step.
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_fmv_err := SQLSTATE || ' ' || SQLERRM;
    v_fmv := jsonb_build_object('failed', true, 'error', v_fmv_err);
    v_ok := false;
  END;

  FOR v_coll IN
    SELECT c.id, c.slug
    FROM collections c
    WHERE EXISTS (SELECT 1 FROM collection_series cs WHERE cs.collection_id = c.id)
    ORDER BY (SELECT min(r.computed_at) FROM series_detail_rollup r WHERE r.collection_id = c.id)
             ASC NULLS FIRST, c.slug
  LOOP
    IF extract(epoch FROM (clock_timestamp() - v_started)) > p_max_seconds THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_t0 := clock_timestamp();

    IF v_coll.id = v_pinnacle THEN
      INSERT INTO series_detail_rollup AS r
        (collection_id, series_number, edition_count, total_circulation,
         fmv_total_usd, floor_total_usd, set_count, player_count, computed_at,
         fmv_ask_derived_usd, listed_count)
      -- 2026-09-26: Pinnacle series counted from the render catalog (its own
      -- season); pinnacle_editions.series_year was set on 87 rows only, so the
      -- rollup read 11 editions for a year with 1,023 pins.
      SELECT
        v_coll.id, cs.series_number,
        count(pc.render_id),
        CASE WHEN count(pc.render_id) = count(pc.total_minted) THEN sum(pc.total_minted) END,
        sum(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0),
        sum(pc.floor_ask)    FILTER (WHERE pc.floor_ask > 0),
        count(DISTINCT btrim(pc.set_name)),
        count(DISTINCT btrim(pc.characters[1])),
        now(),
        sum(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0 AND pc.fmv_confidence::text = 'ASK_ONLY'),
        count(pc.render_id)  FILTER (WHERE pc.floor_ask > 0)
      FROM collection_series cs
      LEFT JOIN pinnacle_catalog pc
        ON pc.series_name = NULLIF(regexp_replace(cs.season, '[^0-9]', '', 'g'), '')
      WHERE cs.collection_id = v_coll.id
      GROUP BY cs.series_number
      ON CONFLICT (collection_id, series_number) DO UPDATE SET
        edition_count = EXCLUDED.edition_count,
        total_circulation = EXCLUDED.total_circulation,
        fmv_total_usd = EXCLUDED.fmv_total_usd,
        floor_total_usd = EXCLUDED.floor_total_usd,
        set_count = EXCLUDED.set_count,
        player_count = EXCLUDED.player_count,
        computed_at = EXCLUDED.computed_at,
        fmv_ask_derived_usd = EXCLUDED.fmv_ask_derived_usd,
        listed_count = EXCLUDED.listed_count;
    ELSE
      INSERT INTO series_detail_rollup AS r
        (collection_id, series_number, edition_count, total_circulation,
         fmv_total_usd, floor_total_usd, set_count, player_count, computed_at)
      SELECT
        v_coll.id, cs.series_number,
        count(e.id),
        CASE WHEN count(e.id) = count(e.circulation_count) THEN sum(e.circulation_count) END,
        sum(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
        sum(COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd)) FILTER (WHERE COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd) > 0),
        count(DISTINCT e.set_name),
        count(DISTINCT COALESCE(e.player_id::text, e.player_name)),
        now()
      FROM collection_series cs
      LEFT JOIN editions e
        ON e.collection_id = cs.collection_id AND e.series = ANY (public.series_chain_numbers(cs.collection_id, cs.series_number))
      LEFT JOIN edition_fmv_current fmv
        ON fmv.edition_id = e.id
      WHERE cs.collection_id = v_coll.id
      GROUP BY cs.series_number
      ON CONFLICT (collection_id, series_number) DO UPDATE SET
        edition_count = EXCLUDED.edition_count,
        total_circulation = EXCLUDED.total_circulation,
        fmv_total_usd = EXCLUDED.fmv_total_usd,
        floor_total_usd = EXCLUDED.floor_total_usd,
        set_count = EXCLUDED.set_count,
        player_count = EXCLUDED.player_count,
        computed_at = EXCLUDED.computed_at;
    END IF;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_ms := (extract(epoch FROM (clock_timestamp() - v_t0)) * 1000)::int;

    UPDATE series_detail_rollup SET duration_ms = v_ms
    WHERE collection_id = v_coll.id;

    DELETE FROM series_detail_rollup r
    WHERE r.collection_id = v_coll.id
      AND NOT EXISTS (
        SELECT 1 FROM collection_series cs
        WHERE cs.collection_id = r.collection_id AND cs.series_number = r.series_number
      );

    v_done := v_done + 1;
    v_written := v_written + v_rows;
    v_detail := v_detail || jsonb_build_object('collection', v_coll.slug, 'series', v_rows, 'ms', v_ms);
  END LOOP;

  IF v_skipped > 0 THEN v_ok := false; END IF;

  PERFORM log_pipeline_run(
    'series-detail-rollup', v_started, NULL, v_written, NULL, v_ok, v_fmv_err, NULL, NULL, NULL,
    jsonb_build_object(
      'collections_done', v_done,
      'collections_skipped_over_budget', v_skipped,
      'max_seconds', p_max_seconds,
      'edition_fmv_current', v_fmv,
      'per_collection', v_detail
    )
  );

  RETURN jsonb_build_object(
    'ok', v_ok,
    'collections_done', v_done,
    'collections_skipped_over_budget', v_skipped,
    'series_written', v_written,
    'edition_fmv_current', v_fmv,
    'elapsed_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int,
    'per_collection', v_detail
  );
END;
$function$;

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
           (CASE WHEN count(*) = count(e.circulation_count) THEN sum(e.circulation_count) END)::bigint AS total_circulation,
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

CREATE OR REPLACE FUNCTION public.get_team_detail(p_collection_id uuid, p_team_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_team_variants text[];
  v_team_canonical text;
  v_collection_slug text;
  v_player_count int;
  v_edition_count int;
  v_total_circulation int;
  v_fmv_total numeric;
  v_floor_total numeric;
  v_fmv_ask_derived numeric;
  v_listed_count int;
  -- Team Hub Phase 1: branding (teams_master) + 30d activity. NULL for Pinnacle.
  v_primary_color text;
  v_secondary_color text;
  v_abbreviation text;
  v_team_external_id text;
  v_league text;
  v_sales_30d int;
  v_volume_30d numeric;
  -- Team Hub Phase 4 (F1a): teams_master short slug, the follow-write key.
  v_team_short_slug text;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- 2026-09-26: the render catalog, by each pin's own Franchises trait (™/®/©
    -- stripped, so "Star Wars™" and "Star Wars" are one franchise). The old read
    -- was pinnacle_editions — set-level keys naming ONE franchise and ONE
    -- character each — so Star Wars listed 129 of its 723 pins and ten
    -- franchises a character page links to had no page at all. A franchise no
    -- catalog pin carries falls through to that old read, unchanged.
    SELECT array_agg(DISTINCT f.name),
           (array_agg(f.name ORDER BY f.name))[1]
    INTO v_team_variants, v_team_canonical
    FROM pinnacle_catalog pc
    CROSS JOIN LATERAL unnest(pc.franchises) AS u(fr)
    CROSS JOIN LATERAL (SELECT btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) AS name) f
    WHERE f.name <> ''
      AND regexp_replace(lower(f.name), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    -- Fallback: the diacritic-stripped slug the frontend emits.
    IF v_team_variants IS NULL THEN
      SELECT array_agg(DISTINCT f.name),
             (array_agg(f.name ORDER BY f.name))[1]
      INTO v_team_variants, v_team_canonical
      FROM pinnacle_catalog pc
      CROSS JOIN LATERAL unnest(pc.franchises) AS u(fr)
      CROSS JOIN LATERAL (SELECT btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) AS name) f
      WHERE f.name <> ''
        AND regexp_replace(lower(extensions.unaccent(f.name)), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    END IF;

    IF v_team_variants IS NOT NULL THEN
      -- The same pins get_team_top_editions / get_team_players list, so the
      -- header counts what the grid and roster show. Characters are counted by
      -- page slug over every name on a pin (a duo pin counts for both).
      WITH pins AS (
        SELECT pc.render_id, pc.characters, pc.total_minted, pc.fmv_usd, pc.floor_ask, pc.fmv_confidence
        FROM pinnacle_catalog pc
        WHERE EXISTS (
            SELECT 1 FROM unnest(pc.franchises) AS u(fr)
            WHERE btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) = ANY (v_team_variants))
      )
      SELECT
        (SELECT COUNT(DISTINCT regexp_replace(lower(btrim(u.ch)), '[^a-z0-9]+', '-', 'g'))
           FROM pins p CROSS JOIN LATERAL unnest(p.characters) AS u(ch)
          WHERE btrim(u.ch) NOT IN ('', 'Unknown')),
        (SELECT COUNT(*) FROM pins),
        (SELECT CASE WHEN COUNT(*) = COUNT(total_minted) THEN SUM(total_minted) END FROM pins),
        (SELECT SUM(fmv_usd) FILTER (WHERE fmv_usd > 0) FROM pins),
        (SELECT SUM(floor_ask) FILTER (WHERE floor_ask > 0) FROM pins),
        (SELECT SUM(fmv_usd) FILTER (WHERE fmv_usd > 0 AND fmv_confidence::text = 'ASK_ONLY') FROM pins),
        (SELECT COUNT(*) FILTER (WHERE floor_ask > 0) FROM pins)
      INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_fmv_ask_derived, v_listed_count;

      -- 2026-09-28: 30-day activity from pinnacle_sales over the same pins (the
      -- shared `sales` table below holds no Pinnacle rows, so this read "—").
      SELECT COUNT(*), COALESCE(SUM(s.sale_price_usd), 0)
      INTO v_sales_30d, v_volume_30d
      FROM pinnacle_sales s
      WHERE s.sold_at >= now() - interval '30 days'
        AND s.sale_price_usd > 0
        AND s.render_id IN (
          SELECT pc.render_id FROM pinnacle_catalog pc
          WHERE EXISTS (
            SELECT 1 FROM unnest(pc.franchises) AS u(fr)
            WHERE btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) = ANY (v_team_variants)));
    ELSE
      SELECT array_agg(DISTINCT franchise),
             (array_agg(franchise ORDER BY franchise))[1]
      INTO v_team_variants, v_team_canonical
      FROM pinnacle_editions
      WHERE franchise IS NOT NULL
        AND regexp_replace(lower(trim(franchise)), '[^a-z0-9]+', '-', 'g') = p_team_slug;

      -- Fallback: accept the diacritic-stripped slug the frontend emits.
      IF v_team_variants IS NULL THEN
        SELECT array_agg(DISTINCT franchise),
               (array_agg(franchise ORDER BY franchise))[1]
        INTO v_team_variants, v_team_canonical
        FROM pinnacle_editions
        WHERE franchise IS NOT NULL
          AND regexp_replace(lower(trim(extensions.unaccent(franchise))), '[^a-z0-9]+', '-', 'g') = p_team_slug;
      END IF;

      IF v_team_variants IS NULL THEN RETURN NULL; END IF;

      -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
      SELECT
        COUNT(DISTINCT pe.character_name),
        COUNT(*),
        CASE WHEN COUNT(pe.id) = COUNT(pe.mint_count) THEN SUM(pe.mint_count) END,
        SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
        SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0)
      INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
      FROM pinnacle_editions pe
      LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
      WHERE pe.franchise = ANY(v_team_variants);
      -- Pinnacle: no teams_master branding, no sports sales activity. Leave NULL.
    END IF;

  ELSE
    -- 2026-09-25 (batch 62): the WHOLE franchise — every label it minted under
    -- (Las Vegas + Oakland + Los Angeles Raiders) — and the canonical name is
    -- the franchise's primary (current) name, so a historic label's URL 308s
    -- to the current page through the layout's canonical-slug redirect.
    SELECT array_agg(DISTINCT team_name)
    INTO v_team_variants
    FROM editions
    WHERE collection_id = p_collection_id
      AND team_name IS NOT NULL
      AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));
    -- (ARRAY(SELECT …) is an InitPlan: the helper runs ONCE, never per scanned row)
    v_team_canonical := public.team_franchise_primary_name(p_collection_id, p_team_slug);

    -- Fallback: accept the diacritic-stripped slug the frontend emits
    -- (e.g. atletico-de-madrid for "Atletico de Madrid"). Runs only on a
    -- would-be 404, so the functional index still serves the hot path.
    IF v_team_variants IS NULL THEN
      SELECT array_agg(DISTINCT team_name),
             (array_agg(team_name ORDER BY team_name))[1]
      INTO v_team_variants, v_team_canonical
      FROM editions
      WHERE collection_id = p_collection_id
        AND team_name IS NOT NULL
        AND regexp_replace(lower(trim(extensions.unaccent(team_name))), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    END IF;

    IF v_team_variants IS NULL THEN RETURN NULL; END IF;

    SELECT
      -- 2026-10-25: persons, not labels (Mahomes / Mahomes II are one player_id) — the roster's grouping.
      COUNT(DISTINCT COALESCE(e.player_id::text, regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g')))
        FILTER (WHERE e.player_name IS NOT NULL AND e.player_name <> ''),
      COUNT(*),
      CASE WHEN COUNT(e.id) = COUNT(e.circulation_count) THEN SUM(e.circulation_count) END,
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd)) FILTER (WHERE COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd) > 0)
    INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants);

    -- Branding: single indexed lookup on slugified team_name (no cross-league
    -- slug collisions verified among active rows, so no league guard needed).
    SELECT tm.slug, tm.primary_color, tm.secondary_color, tm.abbreviation, tm.external_id, tm.league::text
    INTO v_team_short_slug, v_primary_color, v_secondary_color, v_abbreviation, v_team_external_id, v_league
    FROM teams_master tm
    WHERE tm.active
      AND regexp_replace(lower(trim(tm.team_name)), '[^a-z0-9]+', '-', 'g')
          = regexp_replace(lower(trim(COALESCE(v_team_canonical, ''))), '[^a-z0-9]+', '-', 'g')
    LIMIT 1;

    -- 30d activity: bounded by the team's editions via edition_id join. The
    -- s.collection_id = p_collection_id predicate (authoritative, equal to
    -- e.collection_id via the join) lets the planner use the sales
    -- (collection_id, sold_at DESC) partition index instead of scanning the
    -- whole recent slice -> keeps the fn under its 8s cap for big TS franchises.
    SELECT COUNT(*), COALESCE(SUM(s.price_usd), 0)
    INTO v_sales_30d, v_volume_30d
    FROM sales s
    JOIN editions e ON e.id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants)
      AND s.sold_at >= now() - interval '30 days';
  END IF;

  RETURN jsonb_build_object(
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'team_slug',         p_team_slug,
    'team_name',         v_team_canonical,
    'team_name_variants',v_team_variants,
    'is_franchise',      p_collection_id = v_pinnacle_uuid,
    'player_count',      v_player_count,
    'edition_count',     v_edition_count,
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'fmv_ask_derived_usd', v_fmv_ask_derived,
    'listed_count',      v_listed_count,
    'primary_color',     v_primary_color,
    'secondary_color',   v_secondary_color,
    'abbreviation',      v_abbreviation,
    'team_external_id',  v_team_external_id,
    'league',            v_league,
    'team_short_slug',   v_team_short_slug,
    'sales_30d',         v_sales_30d,
    'volume_30d_usd',    v_volume_30d
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_team_players(p_collection_id uuid, p_team_slug text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_limit    int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_safe_offset   int := GREATEST(COALESCE(p_offset, 0), 0);
  v_team_variants text[];
  result          jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    -- 2026-09-26: the render catalog, by each pin's own Franchises trait (™/®/©
    -- stripped, so "Star Wars™" and "Star Wars" are one franchise). The old read
    -- was pinnacle_editions — set-level keys naming ONE franchise and ONE
    -- character each — so Star Wars listed 129 of its 723 pins and ten
    -- franchises a character page links to had no page at all. A franchise no
    -- catalog pin carries falls through to that old read, unchanged.
    SELECT array_agg(DISTINCT f.name)
    INTO v_team_variants
    FROM pinnacle_catalog pc
    CROSS JOIN LATERAL unnest(pc.franchises) AS u(fr)
    CROSS JOIN LATERAL (SELECT btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) AS name) f
    WHERE f.name <> ''
      AND regexp_replace(lower(f.name), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    IF v_team_variants IS NOT NULL THEN
      -- One row per character page (slug), over every name on a pin.
      WITH ch AS (
        SELECT btrim(u.ch) AS name, pc.render_id, pc.total_minted, pc.fmv_usd, pc.thumbnail_url
        FROM pinnacle_catalog pc
        CROSS JOIN LATERAL unnest(pc.characters) AS u(ch)
        WHERE btrim(u.ch) NOT IN ('', 'Unknown')
          AND EXISTS (
            SELECT 1 FROM unnest(pc.franchises) AS u(fr)
            WHERE btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) = ANY (v_team_variants))
      ),
      chars AS (
        SELECT
          (array_agg(ch.render_id ORDER BY ch.fmv_usd DESC NULLS LAST, ch.render_id))[1] AS id,
          MIN(ch.name) AS name,
          regexp_replace(lower(ch.name), '[^a-z0-9]+', '-', 'g') AS player_slug,
          NULL::text AS headshot_url,
          NULL::int  AS jersey_number,
          NULL::text AS position,
          NULL::boolean AS is_active,
          false AS is_rookie,
          COUNT(DISTINCT ch.render_id) AS edition_count,
          CASE WHEN COUNT(*) = COUNT(ch.total_minted) THEN SUM(ch.total_minted) END AS total_circulation,
          SUM(ch.fmv_usd)      FILTER (WHERE ch.fmv_usd > 0) AS fmv_total_usd,
          (array_agg(ch.thumbnail_url ORDER BY ch.fmv_usd DESC NULLS LAST, ch.render_id) FILTER (WHERE ch.thumbnail_url IS NOT NULL))[1] AS portrait_thumbnail
        FROM ch
        GROUP BY regexp_replace(lower(ch.name), '[^a-z0-9]+', '-', 'g')
        ORDER BY fmv_total_usd DESC NULLS LAST, edition_count DESC, name
        LIMIT v_safe_limit OFFSET v_safe_offset
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(chars.*)), '[]'::jsonb) INTO result FROM chars;
      RETURN result;
    END IF;

    SELECT array_agg(DISTINCT franchise) INTO v_team_variants
    FROM pinnacle_editions
    WHERE franchise IS NOT NULL
      AND regexp_replace(lower(trim(franchise)), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    IF v_team_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

    WITH chars AS (
      SELECT
        (array_agg(pe.id ORDER BY pe.minting_date DESC NULLS LAST))[1] AS id,
        pe.character_name AS name,
        regexp_replace(lower(trim(pe.character_name)), '[^a-z0-9]+', '-', 'g') AS player_slug,
        NULL::text AS headshot_url,
        NULL::int  AS jersey_number,
        NULL::text AS position,
        NULL::boolean AS is_active,
        false AS is_rookie,
        COUNT(*) AS edition_count,
        CASE WHEN COUNT(pe.id) = COUNT(pe.mint_count) THEN SUM(pe.mint_count) END AS total_circulation,
        SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0) AS fmv_total_usd,
        (array_agg(pe.thumbnail_url ORDER BY pe.minting_date DESC NULLS LAST) FILTER (WHERE pe.thumbnail_url IS NOT NULL))[1] AS portrait_thumbnail
      FROM pinnacle_editions pe
      -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
      LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
      WHERE pe.franchise = ANY(v_team_variants)
      GROUP BY pe.character_name
      ORDER BY fmv_total_usd DESC NULLS LAST, edition_count DESC, name
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(chars.*)), '[]'::jsonb) INTO result FROM chars;
  ELSE
    SELECT array_agg(DISTINCT team_name) INTO v_team_variants
    FROM editions
    WHERE collection_id = p_collection_id
      AND team_name IS NOT NULL
      AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));  -- 2026-09-25 (batch 62): the whole franchise, historic labels included; ARRAY(SELECT …) is an InitPlan (the helper runs once)

    IF v_team_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

    -- 2026-10-25: one row per PERSON, not per label. editions.player_name is the league's
    -- LABEL and editions.player_id the person (player-identity.md, 10-20), so grouping by the
    -- label's slug split Patrick Mahomes into "Patrick Mahomes" (6) and "Patrick Mahomes II"
    -- (26, FMV $16.5k) on the Chiefs page, and the second row had no players match (id NULL),
    -- so the page dropped it. Group by player_id, falling back to the label only when it is
    -- NULL (team Moments, unlinked rows); name and slug come from the linked row.
    WITH team_eds AS (
      SELECT
        e.id,
        e.player_id,
        e.player_name,
        regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') AS label_slug,
        e.circulation_count,
        e.thumbnail_url,
        e.first_minted_at
      FROM editions e
      WHERE e.collection_id = p_collection_id
        AND e.team_name = ANY(v_team_variants)
        AND e.player_name IS NOT NULL
        AND e.player_name <> ''
    ),
    agg AS (
      SELECT
        (array_agg(te.player_id) FILTER (WHERE te.player_id IS NOT NULL))[1] AS player_id,
        MIN(te.player_name) AS label_name,
        MIN(te.label_slug) AS label_slug,
        COUNT(DISTINCT te.id) AS edition_count,
        CASE WHEN COUNT(te.id) = COUNT(te.circulation_count) THEN SUM(te.circulation_count) END AS total_circulation,
        SUM(fmv.fmv_usd) FILTER (WHERE fmv.fmv_usd > 0) AS fmv_total_usd,
        (array_agg(te.thumbnail_url ORDER BY te.first_minted_at DESC NULLS LAST) FILTER (WHERE te.thumbnail_url IS NOT NULL))[1] AS portrait_thumbnail
      FROM team_eds te
      LEFT JOIN LATERAL (
        SELECT fmv_usd FROM fmv_snapshots
        WHERE edition_id = te.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      GROUP BY COALESCE(te.player_id::text, te.label_slug)
    ),
    matched AS (
      SELECT
        a.*,
        COALESCE(pid.id, plbl.id) AS pm_id,
        COALESCE(pid.name, plbl.name) AS pm_name,
        COALESCE(pid.headshot_url, plbl.headshot_url) AS headshot_url,
        COALESCE(pid.jersey_number, plbl.jersey_number) AS jersey_number,
        COALESCE(pid.position, plbl.position) AS position,
        COALESCE(pid.is_active, plbl.is_active) AS is_active
      FROM agg a
      -- the linked person
      LEFT JOIN LATERAL (
        SELECT p.id, p.name, p.headshot_url, p.jersey_number, p.position, p.is_active
        FROM players p
        WHERE a.player_id IS NOT NULL
          AND p.id = a.player_id
          AND p.collection_id = p_collection_id
      ) pid ON true
      -- no link: the label's namesake row, as before
      LEFT JOIN LATERAL (
        SELECT p.id, p.name, p.headshot_url, p.jersey_number, p.position, p.is_active
        FROM players p
        WHERE a.player_id IS NULL
          AND p.collection_id = p_collection_id
          AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = a.label_slug
        ORDER BY (p.headshot_url IS NOT NULL) DESC, p.id
        LIMIT 1
      ) plbl ON true
    ),
    with_meta AS (
      SELECT
        m.pm_id AS id,
        COALESCE(m.pm_name, m.label_name) AS name,
        COALESCE(regexp_replace(lower(trim(m.pm_name)), '[^a-z0-9]+', '-', 'g'), m.label_slug) AS player_slug,
        m.headshot_url,
        m.jersey_number,
        m.position,
        m.is_active,
        EXISTS (
          SELECT 1 FROM topshot_2025_rookie_players r
          WHERE regexp_replace(lower(trim(r.player_name)), '[^a-z0-9]+', '-', 'g')
                = COALESCE(regexp_replace(lower(trim(m.pm_name)), '[^a-z0-9]+', '-', 'g'), m.label_slug)
        ) AS is_rookie,
        m.edition_count,
        m.total_circulation,
        m.fmv_total_usd,
        m.portrait_thumbnail
      FROM matched m
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb) INTO result
    FROM (
      SELECT * FROM with_meta
      ORDER BY fmv_total_usd DESC NULLS LAST, edition_count DESC, name
      LIMIT v_safe_limit OFFSET v_safe_offset
    ) t;
  END IF;

  RETURN result;
END;
$function$;
