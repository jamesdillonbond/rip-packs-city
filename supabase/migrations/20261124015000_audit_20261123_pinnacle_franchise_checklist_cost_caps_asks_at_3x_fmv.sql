-- audit_20261123: Disney Pinnacle franchise checklist (TeamChecklist on /disney-pinnacle/team/<slug>) — cost to complete
-- counts a live ask only within 3x the pin's FMV, like every other collection's arm. Measured 11-23 ~5:50 PM PT: the
-- Pinnacle arm summed COALESCE(raw floor_ask, fmv), so Mickey & Friends read $1,828,613 "to complete" ($1,000,000 of it
-- one never-sold 1/1 Apex ask) and Toy Story $60,269 ($32,500 of asks on pins with no FMV), under copy that says
-- "live low asks (within 3x FMV)". Now: ask <= 3x FMV -> the ask; above -> FMV; no FMV -> unpriced (adds nothing, and
-- the existing stale_missing_pct still counts it). Only the Pinnacle catalog arm's floor_usd line changes; the tiles
-- (get_team_checklist) keep showing the real ask.
-- Base verified: live prosrc md5 3bcea8fc57ebab9d905df9bbdff5fa85 = the body in 20261028141531.
-- anon-exec: unchanged (get_team_checklist_progress) — CREATE OR REPLACE keeps the ACL (postgres + service_role).
-- Revert: re-apply get_team_checklist_progress from 20261028141531.

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
          -- 2026-11-23: a live ask counts toward cost only within 3x the pin's FMV (the generic arm's rule since
          -- 2026-10-03, and what the checklist's copy already promised). A raw ask put a never-sold $1,000,000
          -- 1/1 listing into Mickey & Friends' cost ($1.83M); past 3x -> its FMV; no FMV -> unpriced (no cost).
          CASE WHEN pc.fmv_usd > 0 AND pc.floor_ask <= pc.fmv_usd * 3 THEN pc.floor_ask END AS floor_usd,
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
        (CASE WHEN p_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN
          -- NFL All Day (2026-10-27): its own season map — collection_series pairs a season series with that
          -- season's historical series, so a historical moment (old game_date) is never contemporary.
          (SELECT NULLIF(regexp_replace(cs.season, '[^0-9]', '', 'g'), '')::int
             FROM collection_series cs
            WHERE cs.collection_id = p_collection_id AND cs.series_number = e.series)
        ELSE (CASE e.series
          WHEN 0 THEN 2019 WHEN 1 THEN 2019 WHEN 2 THEN 2020 WHEN 3 THEN 2021
          WHEN 4 THEN 2021 WHEN 5 THEN 2022 WHEN 6 THEN 2023 WHEN 7 THEN 2024
          WHEN 8 THEN 2025 WHEN 9 THEN 2026 ELSE NULL END) END) AS series_season,
        (CASE WHEN e.game_date IS NULL THEN NULL
              -- NFL All Day (2026-10-28): its season opens in MARCH — the draft (late April) and Rookie Debut / preseason
              -- (July–August) belong to the season that follows; January–February (playoffs, Super Bowl) close the one
              -- before. Top Shot's August cutoff put 2025's NFL Draft + Rookie Debut (136 editions) in season 2024.
              WHEN EXTRACT(month FROM e.game_date) >= (CASE WHEN p_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN 3 ELSE 8 END)
                THEN EXTRACT(year FROM e.game_date)::int
              ELSE EXTRACT(year FROM e.game_date)::int - 1 END) AS play_season,
        fmv.fmv_usd,
        ask.live_ask AS floor_usd,
        fmv.confidence::text AS fmv_confidence
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, confidence FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      -- 2026-10-03: floor_usd is the LIVE low ask (what a buyer pays now), never
      -- the snapshot's historical floor column — for a sales-priced row that is the minimum
      -- HISTORICAL sale (schema-truth.md), and it understated cost-to-add on
      -- 90 % of Top Shot editions (live ask 1.49x it at the median; All Day 2.0x).
      -- Same source order as get_edition_high_offer's base-edition rule: the All
      -- Day live floor, then the GQL marketplace row, then badge_editions (both
      -- <= 7 d old), and only when CONNECTED to FMV (<= 3x, the estate's
      -- disconnected-ask multiple) — a troll ask falls through to FMV via the
      -- COALESCE(floor_usd, fmv_usd) the readers already apply. No live ask ->
      -- NULL -> FMV, never the historical minimum. No FMV at all -> NULL too: a
      -- lone ask on an unpriced edition is the troll shape (a $100,000 ask on a
      -- STALE Lakers Legendary tripled one team's cost-to-complete in the first
      -- cut of this rule), so it stays unpriced, as it was.
      LEFT JOIN LATERAL (
        SELECT a.ask AS live_ask
        FROM (
          SELECT afa.floor_ask AS ask, 1 AS pri
          FROM allday_edition_floor_ask afa
          WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
            AND afa.edition_id = e.id
          UNION ALL
          SELECT eo.low_ask, 2
          FROM edition_offers eo
          WHERE eo.collection_id = e.collection_id AND eo.external_id = e.external_id
            AND eo.low_ask > 0 AND eo.low_ask_confirmed_at > now() - interval '7 days'
          UNION ALL
          SELECT be.low_ask, 3
          FROM badge_editions be
          WHERE be.collection_id = e.collection_id AND be.external_id = e.external_id
            AND be.low_ask > 0 AND be.updated_at > now() - interval '7 days'
          ORDER BY pri
          LIMIT 1
        ) a
        WHERE fmv.fmv_usd IS NOT NULL AND a.ask <= fmv.fmv_usd * 3
      ) ask ON true
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

