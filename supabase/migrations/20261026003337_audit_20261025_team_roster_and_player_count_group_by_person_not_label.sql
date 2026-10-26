-- 2026-10-25 (PT) — the team roster and the team header's player count group by PERSON
-- (editions.player_id), not by the league's label (editions.player_name).
--
-- WHY. Production HTML sweep, 10-25 ~5:30 PM PT: /nfl-all-day/team/kansas-city-chiefs listed
-- "Patrick Mahomes · 6 editions · FMV $892" and no "Patrick Mahomes II" row at all, while its Top
-- Editions grid showed 12 "Patrick Mahomes II" cards ($6,999, $3,599 …); the header said "Players
-- 65" over 64 roster rows. Both labels carry ONE player_id (d44a2afe…, players.name "Patrick
-- Mahomes"). get_team_players grouped by the label's slug, so "patrick-mahomes-ii" became its own
-- row (26 editions, FMV $16,516) with no players match (id NULL, is_active NULL), which the roster's default "Current" view (is_active = true only) hid;
-- get_team_detail counted label slugs. player-identity.md (10-20): anything that GROUPS, LINKS or
-- COUNTS by person keys on player_id, falling back to the label only when it is NULL — the 10-20
-- pass fixed four readers but not these two. Measured: 78 people / 367 editions have an edition
-- label whose slug differs from their players.name (All Day 53 / 193, Top Shot 22 / 153, Panini
-- 1 / 18, Golazos 2 / 3).
--
-- WHAT. get_team_players (non-Pinnacle branch only): group by COALESCE(player_id, label slug);
-- name / slug / headshot / jersey / position from the LINKED players row (by id, same
-- collection), else — unlinked rows and team Moments — the label's namesake row exactly as
-- before. get_team_detail: player_count = COUNT(DISTINCT COALESCE(player_id, label slug)).
-- Pinnacle branches, every other line, signatures, SECURITY DEFINER, search_path,
-- statement_timeout and ACLs unchanged (CREATE OR REPLACE).
-- anon-exec: unchanged (get_team_players, get_team_detail) — CREATE OR REPLACE of existing fns; ACLs preserved.
--
-- Pins: supabase/tests/get_team_top_editions.sql (get_team_players), supabase/tests/get_team_detail.sql.
-- Revert: re-apply get_team_players from 20260926195205 and get_team_detail from 20261025235754.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_team_players(uuid,text,integer,integer)'::regprocedure) IS DISTINCT FROM 'cb63202fbca8dd005adcfaf87d7b92af' THEN
    RAISE EXCEPTION 'get_team_players changed since the splice base -- re-splice';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_team_detail(uuid,text)'::regprocedure) IS DISTINCT FROM '84e4b6b1cc5ae19ba3948d0fa311fe25' THEN
    RAISE EXCEPTION 'get_team_detail changed since the splice base -- re-splice';
  END IF;
END
$guard$;

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
          SUM(ch.total_minted) FILTER (WHERE ch.total_minted IS NOT NULL) AS total_circulation,
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
        SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL) AS total_circulation,
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
        SUM(te.circulation_count) FILTER (WHERE te.circulation_count IS NOT NULL) AS total_circulation,
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
      -- 2026-10-25: persons, not labels (Mahomes / Mahomes II are one player_id) — the roster's grouping.
      COUNT(DISTINCT COALESCE(e.player_id::text, regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g')))
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
