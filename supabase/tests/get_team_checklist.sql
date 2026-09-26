-- DB invariant: public.get_team_checklist + public.get_team_checklist_progress —
-- the Pinnacle branch (the franchise checklist and its progress bar). Added
-- 2026-09-26: ownership was joined on pinnacle_editions.external_id, which
-- matched none of the keys wallets hold, so every wallet read 0 owned. Claims:
--
--   1. The checklist lists the franchise's catalog pins (™ stripped, every
--      franchise a pin names), ownership by the PIN held (render_id) — owning
--      one pin of a set-level key does not mark its siblings owned.
--   2. owned / owned_count / owned_locked per pin; no wallet -> owned NULL.
--   3. Progress counts the same pins: owned, locked, completion, cost to
--      complete over the pins NOT held (floor, else FMV), per tier.
--   4. series_<year> scopes to the pin's own series.
--   5. A franchise no catalog pin names falls through to the legacy read, and
--      its ownership now matches the legacy key the wallet holds.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926211121_audit_20260926_pinnacle_franchise_checklist_sees_what_a_wallet_holds.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_catalog (
  render_id text PRIMARY KEY, franchises text[], characters text[], character_name text,
  set_name text, variant text, series_name text, total_minted int, thumbnail_url text,
  fmv_usd numeric, floor_ask numeric, fmv_confidence text, fmv_computed_at timestamptz);
CREATE TABLE public.wallet_moments_cache (
  wallet_address text, collection_id uuid, edition_key text, render_id text, is_locked boolean);
CREATE TABLE public.pinnacle_editions (
  id text PRIMARY KEY, external_id text, franchise text, character_name text, variant_type text,
  set_name text, series_year int, mint_count int, thumbnail_url text);
CREATE FUNCTION public.get_pinnacle_edition_fmv_collapsed(p_id text)
 RETURNS TABLE(fmv_usd numeric, floor_usd numeric, confidence text, computed_at timestamptz)
 LANGUAGE sql STABLE AS $$ SELECT 3::numeric, 2::numeric, 'LOW', now() WHERE p_id IS NOT NULL $$;

CREATE OR REPLACE FUNCTION public.get_team_checklist(p_collection_id uuid, p_team_slug text, p_scope text DEFAULT 'all_time'::text, p_wallet text DEFAULT NULL::text, p_limit integer DEFAULT 60, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_limit    int := LEAST(GREATEST(COALESCE(p_limit, 60), 1), 200);
  v_safe_offset   int := GREATEST(COALESCE(p_offset, 0), 0);
  v_series_filter int := NULL;
  v_team_variants text[];
  result          jsonb;
BEGIN
  -- series_<n> scope -> integer series filter (safe parse only)
  IF p_scope ~ '^series_[0-9]+$' THEN
    v_series_filter := substring(p_scope from 8)::int;
  END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- 2026-09-26: the render catalog, by each pin's own Franchises trait (™/®/©
    -- stripped) — the same pins get_team_top_editions lists — and ownership by
    -- the pin a wallet holds (wallet_moments_cache.render_id, set on every
    -- Pinnacle row). The old read joined ownership on pinnacle_editions.external_id,
    -- which matched NONE of the 431 keys wallets hold, so every wallet read 0
    -- owned. A franchise no catalog pin names falls through to that old read,
    -- its ownership join corrected to the legacy key (pe.id).
    SELECT array_agg(DISTINCT f.name)
    INTO v_team_variants
    FROM pinnacle_catalog pc
    CROSS JOIN LATERAL unnest(pc.franchises) AS u(fr)
    CROSS JOIN LATERAL (SELECT btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) AS name) f
    WHERE f.name <> ''
      AND regexp_replace(lower(f.name), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    IF v_team_variants IS NOT NULL THEN
      WITH owned_renders AS (
        SELECT w.render_id AS rid, COUNT(*)::int AS cnt, bool_or(w.is_locked) AS any_locked
        FROM wallet_moments_cache w
        WHERE p_wallet IS NOT NULL
          AND w.wallet_address = p_wallet
          AND w.collection_id = p_collection_id
          AND w.render_id IS NOT NULL
        GROUP BY w.render_id
      ),
      scoped AS (
        SELECT
          pc.render_id                                        AS route_slug,
          btrim(pc.characters[1])                             AS player_name,
          btrim(pc.character_name) || ' (' || pc.variant || ')' AS name,
          btrim(pc.set_name)                                  AS set_name,
          regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g') AS set_slug,
          pc.variant                                          AS tier,
          99                                                  AS tier_rank,
          pc.series_name                                      AS series_label,
          CASE WHEN pc.series_name ~ '^[0-9]{4}$' THEN pc.series_name::int END AS series_num,
          pc.total_minted                                     AS circulation_count,
          pc.thumbnail_url,
          v_team_variants[1]                                  AS team_name,
          pc.fmv_usd,
          pc.floor_ask                                        AS floor_usd,
          pc.fmv_confidence::text                             AS fmv_confidence,
          pc.fmv_computed_at
        FROM pinnacle_catalog pc
        WHERE EXISTS (
            SELECT 1 FROM unnest(pc.franchises) AS u(fr)
            WHERE btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) = ANY (v_team_variants))
          AND (v_series_filter IS NULL OR pc.series_name = v_series_filter::text)
      ),
      ed AS (
        SELECT
          s.route_slug, s.player_name, s.name, s.set_name, s.set_slug, s.tier, s.tier_rank,
          s.series_label, s.series_num, s.circulation_count, s.thumbnail_url, s.team_name,
          s.fmv_usd, s.floor_usd, s.fmv_confidence, s.fmv_computed_at,
          CASE WHEN p_wallet IS NULL THEN NULL ELSE COALESCE(ok.cnt, 0) > 0 END AS owned,
          COALESCE(ok.cnt, 0) AS owned_count,
          CASE WHEN p_wallet IS NULL THEN NULL
               ELSE (COALESCE(ok.cnt, 0) > 0 AND COALESCE(ok.any_locked, false)) END AS owned_locked
        FROM scoped s
        LEFT JOIN owned_renders ok ON ok.rid = s.route_slug
        ORDER BY
          CASE WHEN p_wallet IS NULL THEN NULL ELSE (COALESCE(ok.cnt, 0) > 0) END ASC NULLS FIRST,
          s.fmv_usd DESC NULLS LAST, s.route_slug
        LIMIT v_safe_limit OFFSET v_safe_offset
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
      RETURN result;
    END IF;

    SELECT array_agg(DISTINCT franchise) INTO v_team_variants
    FROM pinnacle_editions
    WHERE franchise IS NOT NULL
      AND regexp_replace(lower(trim(franchise)), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    IF v_team_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

    WITH owned_keys AS (
      SELECT w.edition_key AS ek, COUNT(*)::int AS cnt, bool_or(w.is_locked) AS any_locked
      FROM wallet_moments_cache w
      WHERE p_wallet IS NOT NULL
        AND w.wallet_address = p_wallet
        AND w.collection_id = p_collection_id
      GROUP BY w.edition_key
    ),
    -- NOTE: Pinnacle has no game_date/series-season concept, so 'contemporary'
    -- degrades to all_time here; only series_<n> (series_year) and all_time apply.
    scoped AS (
      SELECT
        pe.id                                              AS route_slug,
        pe.id                                              AS ext_key,  -- 2026-09-26: wmc keys Pinnacle by the legacy key (= id); external_id matched none
        pe.character_name                                  AS player_name,
        pe.character_name || ' (' || pe.variant_type || ')' AS name,
        pe.set_name,
        regexp_replace(lower(pe.set_name), '[^a-z0-9]+', '-', 'g') AS set_slug,
        pe.variant_type                                    AS tier,
        99                                                 AS tier_rank,
        pe.series_year::text                               AS series_label,
        pe.series_year                                     AS series_num,
        pe.mint_count                                      AS circulation_count,
        pe.thumbnail_url,
        pe.franchise                                       AS team_name,
        fmv.fmv_usd,
        fmv.floor_usd                                      AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence,
        fmv.computed_at                                    AS fmv_computed_at
      FROM pinnacle_editions pe
      -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
      LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
      WHERE pe.franchise = ANY(v_team_variants)
        AND pe.thumbnail_url IS NOT NULL
        AND (v_series_filter IS NULL OR pe.series_year = v_series_filter)
    ),
    ed AS (
      SELECT
        s.route_slug, s.player_name, s.name, s.set_name, s.set_slug, s.tier, s.tier_rank,
        s.series_label, s.series_num, s.circulation_count, s.thumbnail_url, s.team_name,
        s.fmv_usd, s.floor_usd, s.fmv_confidence, s.fmv_computed_at,
        CASE WHEN p_wallet IS NULL THEN NULL ELSE COALESCE(ok.cnt, 0) > 0 END AS owned,
        COALESCE(ok.cnt, 0) AS owned_count,
        CASE WHEN p_wallet IS NULL THEN NULL
             ELSE (COALESCE(ok.cnt, 0) > 0 AND COALESCE(ok.any_locked, false)) END AS owned_locked
      FROM scoped s
      LEFT JOIN owned_keys ok ON ok.ek = s.ext_key
      ORDER BY
        CASE WHEN p_wallet IS NULL THEN NULL ELSE (COALESCE(ok.cnt, 0) > 0) END ASC NULLS FIRST,
        s.fmv_usd DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;

  ELSE
    SELECT array_agg(DISTINCT team_name) INTO v_team_variants
    FROM editions
    WHERE collection_id = p_collection_id
      AND team_name IS NOT NULL
      AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));  -- 2026-09-25 (batch 62): the whole franchise, historic labels included; ARRAY(SELECT …) is an InitPlan (the helper runs once)
    IF v_team_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

    WITH owned_keys AS (
      SELECT w.edition_key AS ek, COUNT(*)::int AS cnt, bool_or(w.is_locked) AS any_locked
      FROM wallet_moments_cache w
      WHERE p_wallet IS NOT NULL
        AND w.wallet_address = p_wallet
        AND w.collection_id = p_collection_id
      GROUP BY w.edition_key
    ),
    base AS (
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.external_id                                      AS ext_key,
        e.player_name,
        e.name,
        e.set_name,
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.tier::text                                       AS tier,
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1 WHEN 'LEGENDARY'  THEN 2 WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4 WHEN 'CONTENDER'  THEN 5 WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7 WHEN 'FANDOM'     THEN 8 WHEN 'COMMON'     THEN 9
          ELSE 99
        END                                                AS tier_rank,
        e.series::text                                     AS series_label,
        e.series                                           AS series_num,
        e.circulation_count,
        e.thumbnail_url,
        e.video_url,
        e.team_name,
        e.play_type,
        (CASE e.series
          WHEN 0 THEN 2019 WHEN 1 THEN 2019 WHEN 2 THEN 2020 WHEN 3 THEN 2021
          WHEN 4 THEN 2021 WHEN 5 THEN 2022 WHEN 6 THEN 2023 WHEN 7 THEN 2024
          WHEN 8 THEN 2025 ELSE NULL END)                  AS series_season,
        (CASE WHEN e.game_date IS NULL THEN NULL
              WHEN EXTRACT(month FROM e.game_date) >= 8 THEN EXTRACT(year FROM e.game_date)::int
              ELSE EXTRACT(year FROM e.game_date)::int - 1 END) AS play_season,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence,
        fmv.computed_at                                    AS fmv_computed_at
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence, computed_at FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.team_name = ANY(v_team_variants)
        AND e.thumbnail_url IS NOT NULL
    ),
    scoped AS (
      SELECT * FROM base
      WHERE CASE
        WHEN p_scope = 'contemporary' THEN (play_season IS NOT NULL AND play_season = series_season)
        WHEN v_series_filter IS NOT NULL THEN series_num = v_series_filter
        ELSE TRUE
      END
    ),
    ed AS (
      SELECT
        s.route_slug, s.player_name, s.name, s.set_name, s.set_slug, s.tier, s.tier_rank,
        s.series_label, s.series_num, s.circulation_count, s.thumbnail_url, s.video_url, s.team_name, s.play_type,
        s.fmv_usd, s.floor_usd, s.fmv_confidence, s.fmv_computed_at,
        -- Per-wallet ownership + lock state from wmc (is_locked). owned_locked
        -- drives the green (owned+locked) vs white (owned) tile parity with TS.
        CASE WHEN p_wallet IS NULL THEN NULL ELSE COALESCE(ok.cnt, 0) > 0 END AS owned,
        COALESCE(ok.cnt, 0) AS owned_count,
        CASE WHEN p_wallet IS NULL THEN NULL
             ELSE (COALESCE(ok.cnt, 0) > 0 AND COALESCE(ok.any_locked, false)) END AS owned_locked
      FROM scoped s
      LEFT JOIN owned_keys ok ON ok.ek = s.ext_key
      ORDER BY
        CASE WHEN p_wallet IS NULL THEN NULL ELSE (COALESCE(ok.cnt, 0) > 0) END ASC NULLS FIRST,
        s.fmv_usd DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  END IF;

  RETURN result;
END;
$function$;
CREATE OR REPLACE FUNCTION public.get_team_checklist_progress(p_collection_id uuid, p_team_slug text, p_scope text DEFAULT 'all_time'::text, p_wallet text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_series_filter int := NULL;
  v_team_variants text[];
  v_wallet_cached boolean := false;
  result          jsonb;
BEGIN
  IF p_scope ~ '^series_[0-9]+$' THEN
    v_series_filter := substring(p_scope from 8)::int;
  END IF;

  IF p_wallet IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM wallet_moments_cache w
      WHERE w.wallet_address = p_wallet AND w.collection_id = p_collection_id
    ) INTO v_wallet_cached;
  END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- 2026-09-26: the render catalog, by each pin's own Franchises trait (™/®/©
    -- stripped) — the same pins get_team_top_editions lists — and ownership by
    -- the pin a wallet holds (wallet_moments_cache.render_id, set on every
    -- Pinnacle row). The old read joined ownership on pinnacle_editions.external_id,
    -- which matched NONE of the 431 keys wallets hold, so every wallet read 0
    -- owned. A franchise no catalog pin names falls through to that old read,
    -- its ownership join corrected to the legacy key (pe.id).
    SELECT array_agg(DISTINCT f.name)
    INTO v_team_variants
    FROM pinnacle_catalog pc
    CROSS JOIN LATERAL unnest(pc.franchises) AS u(fr)
    CROSS JOIN LATERAL (SELECT btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) AS name) f
    WHERE f.name <> ''
      AND regexp_replace(lower(f.name), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    IF v_team_variants IS NOT NULL THEN
      WITH owned_renders AS (
        SELECT w.render_id AS rid, COUNT(*)::int AS cnt, bool_or(w.is_locked) AS any_locked
        FROM wallet_moments_cache w
        WHERE p_wallet IS NOT NULL
          AND w.wallet_address = p_wallet
          AND w.collection_id = p_collection_id
          AND w.render_id IS NOT NULL
        GROUP BY w.render_id
      ),
      joined AS (
        SELECT
          pc.variant AS tier,
          99 AS tier_rank,
          pc.fmv_usd,
          pc.floor_ask AS floor_usd,
          pc.fmv_confidence::text AS fmv_confidence,
          CASE WHEN p_wallet IS NULL THEN false ELSE COALESCE(ok.cnt,0) > 0 END AS owned,
          CASE WHEN p_wallet IS NULL THEN false ELSE (COALESCE(ok.cnt,0) > 0 AND COALESCE(ok.any_locked,false)) END AS owned_locked
        FROM pinnacle_catalog pc
        LEFT JOIN owned_renders ok ON ok.rid = pc.render_id
        WHERE EXISTS (
            SELECT 1 FROM unnest(pc.franchises) AS u(fr)
            WHERE btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) = ANY (v_team_variants))
          AND (v_series_filter IS NULL OR pc.series_name = v_series_filter::text)
      ),
      agg AS (
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE owned) AS owned_n,
          COUNT(*) FILTER (WHERE owned_locked) AS locked_owned_n,
          SUM(COALESCE(floor_usd, fmv_usd)) FILTER (WHERE NOT owned) AS cost,
          COUNT(*) FILTER (WHERE NOT owned AND fmv_confidence IN ('STALE','LOW','NO_DATA')) AS stale_n,
          COUNT(*) FILTER (WHERE NOT owned) AS missing_n
        FROM joined
      ),
      tiers AS (
        SELECT tier, MIN(tier_rank) AS rnk, COUNT(*) AS total,
          COUNT(*) FILTER (WHERE owned) AS owned_n,
          SUM(COALESCE(floor_usd, fmv_usd)) FILTER (WHERE NOT owned) AS cost_usd
        FROM joined GROUP BY tier
      )
      SELECT jsonb_build_object(
        'total', a.total,
        'owned', a.owned_n,
        'locked_owned', a.locked_owned_n,
        'missing_count', a.total - a.owned_n,
        'completion_pct', round(100.0 * a.owned_n / NULLIF(a.total,0), 1),
        'cost_to_complete_usd', round(COALESCE(a.cost,0)::numeric, 2),
        'stale_missing_pct', round(100.0 * a.stale_n / NULLIF(a.missing_n,0), 0),
        'wallet_cached', v_wallet_cached,
        'scope', p_scope,
        'by_tier', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('tier', t.tier, 'total', t.total, 'owned', t.owned_n, 'cost_usd', round(COALESCE(t.cost_usd,0)::numeric,2)) ORDER BY t.rnk, t.total DESC)
          FROM tiers t), '[]'::jsonb)
      ) INTO result FROM agg a;
      RETURN result;
    END IF;

    SELECT array_agg(DISTINCT franchise) INTO v_team_variants
    FROM pinnacle_editions
    WHERE franchise IS NOT NULL
      AND regexp_replace(lower(trim(franchise)), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    IF v_team_variants IS NULL THEN
      RETURN jsonb_build_object('total',0,'owned',0,'locked_owned',0,'missing_count',0,'completion_pct',0,
        'cost_to_complete_usd',0,'stale_missing_pct',0,'wallet_cached',v_wallet_cached,
        'scope',p_scope,'by_tier','[]'::jsonb);
    END IF;

    WITH owned_keys AS (
      SELECT w.edition_key AS ek, COUNT(*)::int AS cnt, bool_or(w.is_locked) AS any_locked
      FROM wallet_moments_cache w
      WHERE p_wallet IS NOT NULL AND w.wallet_address = p_wallet AND w.collection_id = p_collection_id
      GROUP BY w.edition_key
    ),
    joined AS (
      SELECT
        pe.variant_type AS tier,
        99 AS tier_rank,
        fmv.fmv_usd,
        fmv.floor_usd,
        fmv.confidence::text AS fmv_confidence,
        CASE WHEN p_wallet IS NULL THEN false ELSE COALESCE(ok.cnt,0) > 0 END AS owned,
        CASE WHEN p_wallet IS NULL THEN false ELSE (COALESCE(ok.cnt,0) > 0 AND COALESCE(ok.any_locked,false)) END AS owned_locked
      FROM pinnacle_editions pe
      -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
      LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
      LEFT JOIN owned_keys ok ON ok.ek = pe.id  -- 2026-09-26: wmc keys Pinnacle by the legacy key (= id); external_id matched none
      WHERE pe.franchise = ANY(v_team_variants)
        AND pe.thumbnail_url IS NOT NULL
        AND (v_series_filter IS NULL OR pe.series_year = v_series_filter)
    ),
    agg AS (
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE owned) AS owned_n,
        COUNT(*) FILTER (WHERE owned_locked) AS locked_owned_n,
        SUM(COALESCE(floor_usd, fmv_usd)) FILTER (WHERE NOT owned) AS cost,
        COUNT(*) FILTER (WHERE NOT owned AND fmv_confidence IN ('STALE','LOW','NO_DATA')) AS stale_n,
        COUNT(*) FILTER (WHERE NOT owned) AS missing_n
      FROM joined
    ),
    tiers AS (
      SELECT tier, MIN(tier_rank) AS rnk, COUNT(*) AS total,
        COUNT(*) FILTER (WHERE owned) AS owned_n,
        SUM(COALESCE(floor_usd, fmv_usd)) FILTER (WHERE NOT owned) AS cost_usd
      FROM joined GROUP BY tier
    )
    SELECT jsonb_build_object(
      'total', a.total,
      'owned', a.owned_n,
      'locked_owned', a.locked_owned_n,
      'missing_count', a.total - a.owned_n,
      'completion_pct', round(100.0 * a.owned_n / NULLIF(a.total,0), 1),
      'cost_to_complete_usd', round(COALESCE(a.cost,0)::numeric, 2),
      'stale_missing_pct', round(100.0 * a.stale_n / NULLIF(a.missing_n,0), 0),
      'wallet_cached', v_wallet_cached,
      'scope', p_scope,
      'by_tier', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('tier', t.tier, 'total', t.total, 'owned', t.owned_n, 'cost_usd', round(COALESCE(t.cost_usd,0)::numeric,2)) ORDER BY t.rnk, t.total DESC)
        FROM tiers t), '[]'::jsonb)
    ) INTO result FROM agg a;

  ELSE
    SELECT array_agg(DISTINCT team_name) INTO v_team_variants
    FROM editions
    WHERE collection_id = p_collection_id
      AND team_name IS NOT NULL
      AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));  -- 2026-09-25 (batch 62): the whole franchise, historic labels included; ARRAY(SELECT …) is an InitPlan (the helper runs once)
    IF v_team_variants IS NULL THEN
      RETURN jsonb_build_object('total',0,'owned',0,'locked_owned',0,'missing_count',0,'completion_pct',0,
        'cost_to_complete_usd',0,'stale_missing_pct',0,'wallet_cached',v_wallet_cached,
        'scope',p_scope,'by_tier','[]'::jsonb);
    END IF;

    WITH owned_keys AS (
      SELECT w.edition_key AS ek, COUNT(*)::int AS cnt, bool_or(w.is_locked) AS any_locked
      FROM wallet_moments_cache w
      WHERE p_wallet IS NOT NULL AND w.wallet_address = p_wallet AND w.collection_id = p_collection_id
      GROUP BY w.edition_key
    ),
    base AS (
      SELECT
        e.external_id AS ext_key,
        e.tier::text AS tier,
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1 WHEN 'LEGENDARY'  THEN 2 WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4 WHEN 'CONTENDER'  THEN 5 WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7 WHEN 'FANDOM'     THEN 8 WHEN 'COMMON'     THEN 9
          ELSE 99 END AS tier_rank,
        e.series AS series_num,
        (CASE e.series
          WHEN 0 THEN 2019 WHEN 1 THEN 2019 WHEN 2 THEN 2020 WHEN 3 THEN 2021
          WHEN 4 THEN 2021 WHEN 5 THEN 2022 WHEN 6 THEN 2023 WHEN 7 THEN 2024
          WHEN 8 THEN 2025 ELSE NULL END) AS series_season,
        (CASE WHEN e.game_date IS NULL THEN NULL
              WHEN EXTRACT(month FROM e.game_date) >= 8 THEN EXTRACT(year FROM e.game_date)::int
              ELSE EXTRACT(year FROM e.game_date)::int - 1 END) AS play_season,
        fmv.fmv_usd,
        fmv.floor_price_usd AS floor_usd,
        fmv.confidence::text AS fmv_confidence
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.team_name = ANY(v_team_variants)
        AND e.thumbnail_url IS NOT NULL
    ),
    scoped AS (
      SELECT * FROM base
      WHERE CASE
        WHEN p_scope = 'contemporary' THEN (play_season IS NOT NULL AND play_season = series_season)
        WHEN v_series_filter IS NOT NULL THEN series_num = v_series_filter
        ELSE TRUE
      END
    ),
    joined AS (
      SELECT s.tier, s.tier_rank, s.fmv_usd, s.floor_usd, s.fmv_confidence,
        CASE WHEN p_wallet IS NULL THEN false ELSE COALESCE(ok.cnt,0) > 0 END AS owned,
        CASE WHEN p_wallet IS NULL THEN false ELSE (COALESCE(ok.cnt,0) > 0 AND COALESCE(ok.any_locked,false)) END AS owned_locked
      FROM scoped s LEFT JOIN owned_keys ok ON ok.ek = s.ext_key
    ),
    agg AS (
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE owned) AS owned_n,
        COUNT(*) FILTER (WHERE owned_locked) AS locked_owned_n,
        SUM(COALESCE(floor_usd, fmv_usd)) FILTER (WHERE NOT owned) AS cost,
        COUNT(*) FILTER (WHERE NOT owned AND fmv_confidence IN ('STALE','LOW','NO_DATA')) AS stale_n,
        COUNT(*) FILTER (WHERE NOT owned) AS missing_n
      FROM joined
    ),
    tiers AS (
      SELECT tier, MIN(tier_rank) AS rnk, COUNT(*) AS total,
        COUNT(*) FILTER (WHERE owned) AS owned_n,
        SUM(COALESCE(floor_usd, fmv_usd)) FILTER (WHERE NOT owned) AS cost_usd
      FROM joined GROUP BY tier
    )
    SELECT jsonb_build_object(
      'total', a.total,
      'owned', a.owned_n,
      'locked_owned', a.locked_owned_n,
      'missing_count', a.total - a.owned_n,
      'completion_pct', round(100.0 * a.owned_n / NULLIF(a.total,0), 1),
      'cost_to_complete_usd', round(COALESCE(a.cost,0)::numeric, 2),
      'stale_missing_pct', round(100.0 * a.stale_n / NULLIF(a.missing_n,0), 0),
      'wallet_cached', v_wallet_cached,
      'scope', p_scope,
      'by_tier', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('tier', t.tier, 'total', t.total, 'owned', t.owned_n, 'cost_usd', round(COALESCE(t.cost_usd,0)::numeric,2)) ORDER BY t.rnk, t.total DESC)
        FROM tiers t), '[]'::jsonb)
    ) INTO result FROM agg a;
  END IF;

  RETURN result;
END;
$function$;

\set pin '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set w '''0xabc'''

-- r1 + r2 share the legacy key SW-A:Standard:1 (two pins of one set-level key).
INSERT INTO public.pinnacle_catalog (render_id, franchises, characters, character_name, set_name, variant, series_name, total_minted, thumbnail_url, fmv_usd, floor_ask, fmv_confidence) VALUES
  ('r1', ARRAY['Star Wars™'], ARRAY['Luke Skywalker'], 'Luke Skywalker', 'Set A', 'Standard', '2024', 100, '/img/r1', 10, 8,    'HIGH'),
  ('r2', ARRAY['Star Wars'],  ARRAY['Leia'],           'Leia',           'Set A', 'Standard', '2024',  50, '/img/r2', 5,  NULL, 'LOW'),
  ('r3', ARRAY['Star Wars'],  ARRAY['Han Solo'],       'Han Solo',       'Set B', 'Golden',   '2025',  10, '/img/r3', 20, 15,   'MEDIUM'),
  ('r4', ARRAY['Moana'],      ARRAY['Moana'],          'Moana',          'Set C', 'Standard', '2025',  25, '/img/r4', 7,  6,    'MEDIUM');
-- The wallet holds r1 twice (one locked) and r4 (another franchise).
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, render_id, is_locked) VALUES
  (:w, :pin::uuid, 'SW-A:Standard:1', 'r1', true),
  (:w, :pin::uuid, 'SW-A:Standard:1', 'r1', false),
  (:w, :pin::uuid, 'MOA-C:Standard:1', 'r4', false),
  (:w, :pin::uuid, 'MRV:Standard:1', NULL, false);
-- Marvel exists ONLY in pinnacle_editions (the legacy fallback); external_id is NOT the key wallets hold.
INSERT INTO public.pinnacle_editions (id, external_id, franchise, character_name, variant_type, set_name, series_year, mint_count, thumbnail_url) VALUES
  ('MRV:Standard:1', '12345', 'Marvel', 'Iron Man', 'Standard', 'Marvel Set', 2024, 500, '/img/m1');

-- ── 1+2. checklist: every Star Wars pin; ownership by the PIN held ───────────
SELECT _assert_eq(jsonb_array_length(public.get_team_checklist(:pin::uuid, 'star-wars', 'all_time', NULL, 60, 0))::text, '3', 'lists every pin naming Star Wars, ™ or not');
SELECT _assert(public.get_team_checklist(:pin::uuid, 'star-wars', 'all_time', NULL, 60, 0) -> 0 -> 'owned' = 'null'::jsonb, 'no wallet -> owned is null, never false');
SELECT _assert_eq((SELECT string_agg((x->>'route_slug') || ':' || (x->>'owned') || ':' || (x->>'owned_count') || ':' || (x->>'owned_locked'), ',')
                   FROM jsonb_array_elements(public.get_team_checklist(:pin::uuid, 'star-wars', 'all_time', :w, 60, 0)) x),
  'r3:false:0:false,r2:false:0:false,r1:true:2:true',
  'missing first by FMV, then held; r1 held twice and locked; r2 shares r1''s legacy key but is NOT held');
SELECT _assert_eq((SELECT string_agg(x->>'route_slug', ',') FROM jsonb_array_elements(public.get_team_checklist(:pin::uuid, 'star-wars', 'series_2025', NULL, 60, 0)) x),
  'r3', 'series_<year> scopes to the pin''s own series');

-- ── 3. progress over the same pins ────────────────────────────────────────────
SELECT _assert_eq((public.get_team_checklist_progress(:pin::uuid, 'star-wars', 'all_time', :w) ->> 'total'), '3', 'progress total = the checklist''s pins');
SELECT _assert_eq((public.get_team_checklist_progress(:pin::uuid, 'star-wars', 'all_time', :w) ->> 'owned'), '1', 'owned = pins held (r1), not keys');
SELECT _assert_eq((public.get_team_checklist_progress(:pin::uuid, 'star-wars', 'all_time', :w) ->> 'locked_owned'), '1', 'r1 has a locked copy');
SELECT _assert_eq((public.get_team_checklist_progress(:pin::uuid, 'star-wars', 'all_time', :w) ->> 'cost_to_complete_usd'), '20.00', 'cost = r3 floor 15 + r2 FMV 5 (no floor)');
SELECT _assert_eq((public.get_team_checklist_progress(:pin::uuid, 'star-wars', 'all_time', :w) ->> 'completion_pct'), '33.3', 'completion 1 of 3');
SELECT _assert_eq((public.get_team_checklist_progress(:pin::uuid, 'star-wars', 'all_time', :w) ->> 'wallet_cached'), 'true', 'wallet_cached true for a cached wallet');
SELECT _assert_eq((public.get_team_checklist_progress(:pin::uuid, 'star-wars', 'series_2025', :w) ->> 'total'), '1', 'series scope in progress too');
SELECT _assert_eq((public.get_team_checklist_progress(:pin::uuid, 'moana', 'all_time', :w) ->> 'owned'), '1', 'a catalog-only franchise sees the held pin');

-- ── 5. legacy fallback, ownership by the legacy key ───────────────────────────
SELECT _assert_eq((public.get_team_checklist(:pin::uuid, 'marvel', 'all_time', :w, 60, 0) -> 0 ->> 'owned'), 'true', 'fallback: ownership matches the legacy key the wallet holds (was external_id: never)');
SELECT _assert_eq((public.get_team_checklist_progress(:pin::uuid, 'marvel', 'all_time', :w) ->> 'owned'), '1', 'fallback progress owned 1');
SELECT _assert_eq(public.get_team_checklist(:pin::uuid, 'no-such-franchise', 'all_time', :w, 60, 0)::text, '[]', 'unknown slug -> []');
SELECT _assert_eq((public.get_team_checklist_progress(:pin::uuid, 'no-such-franchise', 'all_time', :w) ->> 'total'), '0', 'unknown slug -> total 0');

SELECT '✓ get_team_checklist + get_team_checklist_progress: all assertions passed' AS result;

ROLLBACK;
