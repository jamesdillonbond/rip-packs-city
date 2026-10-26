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

-- PART C of 3 (get_team_detail, get_team_sets; needs recent_low_usd from part A). Split only to keep each apply small.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_team_detail(uuid,text)'::regprocedure) IS DISTINCT FROM 'ce953fc110e3063ce151caaefac2a1bb' THEN
    RAISE EXCEPTION 'get_team_detail changed since the splice base -- re-splice';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_team_sets(uuid,text,text)'::regprocedure) IS DISTINCT FROM 'df8a1747ca205e20edaef4f0e179efe8' THEN
    RAISE EXCEPTION 'get_team_sets changed since the splice base -- re-splice';
  END IF;
END
$guard$;

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
        (SELECT SUM(total_minted) FILTER (WHERE total_minted IS NOT NULL) FROM pins),
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
        SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
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
      COUNT(DISTINCT regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g'))
        FILTER (WHERE e.player_name IS NOT NULL AND e.player_name <> ''),
      COUNT(*),
      SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
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

CREATE OR REPLACE FUNCTION public.get_team_sets(p_collection_id uuid, p_team_slug text, p_wallet text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_variants text[];
  result     jsonb;
BEGIN
  -- 2026-09-26: Disney Pinnacle has no `editions` rows, so this section read
  -- [] and the franchise page hid it. Its sets come from the render catalog:
  -- the pins get_team_top_editions lists (each pin's Franchises trait, ™/®/©
  -- stripped), grouped by the trimmed set name — the slug the set pages
  -- resolve — with ownership by the pin a wallet holds (render_id).
  IF p_collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid THEN
    SELECT array_agg(DISTINCT f.name) INTO v_variants
    FROM pinnacle_catalog pc
    CROSS JOIN LATERAL unnest(pc.franchises) AS u(fr)
    CROSS JOIN LATERAL (SELECT btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) AS name) f
    WHERE f.name <> ''
      AND regexp_replace(lower(f.name), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    IF v_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

    WITH owned AS (
      SELECT DISTINCT w.render_id AS rid
      FROM wallet_moments_cache w
      WHERE p_wallet IS NOT NULL
        AND w.wallet_address = p_wallet
        AND w.collection_id = p_collection_id
        AND w.render_id IS NOT NULL
    ),
    te AS (
      SELECT
        btrim(pc.set_name) AS set_name,
        regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g') AS set_slug,
        pc.fmv_usd,
        pc.floor_ask AS floor_price_usd,
        (o.rid IS NOT NULL) AS owned
      FROM pinnacle_catalog pc
      LEFT JOIN owned o ON o.rid = pc.render_id
      WHERE EXISTS (
          SELECT 1 FROM unnest(pc.franchises) AS u(fr)
          WHERE btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) = ANY (v_variants))
        AND pc.set_name IS NOT NULL
        AND btrim(pc.set_name) <> ''
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(g.*) ORDER BY g.editions DESC, g.set_name), '[]'::jsonb) INTO result FROM (
      SELECT
        te.set_slug,
        MIN(te.set_name) AS set_name,
        COUNT(*) AS editions,
        MIN(COALESCE(te.floor_price_usd, te.fmv_usd)) FILTER (WHERE COALESCE(te.floor_price_usd, te.fmv_usd) > 0) AS cheapest_entry_usd,
        CASE WHEN p_wallet IS NULL THEN NULL ELSE COUNT(*) FILTER (WHERE te.owned) END AS owned
      FROM te
      GROUP BY te.set_slug
    ) g;
    RETURN result;
  END IF;

  SELECT array_agg(DISTINCT team_name) INTO v_variants
  FROM editions
  WHERE collection_id = p_collection_id
    AND team_name IS NOT NULL
    AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));  -- 2026-09-25 (batch 62): the whole franchise, historic labels included; ARRAY(SELECT …) is an InitPlan (the helper runs once)
  IF v_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

  WITH owned_keys AS (
    SELECT w.edition_key AS ek
    FROM wallet_moments_cache w
    WHERE p_wallet IS NOT NULL
      AND w.wallet_address = p_wallet
      AND w.collection_id = p_collection_id
    GROUP BY w.edition_key
  ),
  te AS (
    SELECT
      e.external_id,
      e.set_name,
      regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') AS set_slug,
      fmv.fmv_usd,
      fmv.floor_price_usd,
      (ok.ek IS NOT NULL) AS owned
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    LEFT JOIN owned_keys ok ON ok.ek = e.external_id
    WHERE e.collection_id = p_collection_id
      AND e.team_name = ANY(v_variants)
      AND e.set_name IS NOT NULL
      AND e.thumbnail_url IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(g.*) ORDER BY g.editions DESC, g.set_name), '[]'::jsonb) INTO result FROM (
    SELECT
      te.set_slug,
      MIN(te.set_name) AS set_name,
      COUNT(*) AS editions,
      MIN(COALESCE(public.recent_low_usd(te.floor_price_usd, te.fmv_usd), te.fmv_usd)) FILTER (WHERE COALESCE(public.recent_low_usd(te.floor_price_usd, te.fmv_usd), te.fmv_usd) > 0) AS cheapest_entry_usd,
      CASE WHEN p_wallet IS NULL THEN NULL ELSE COUNT(*) FILTER (WHERE te.owned) END AS owned
    FROM te
    GROUP BY te.set_slug
  ) g;

  RETURN result;
END;
$function$;
