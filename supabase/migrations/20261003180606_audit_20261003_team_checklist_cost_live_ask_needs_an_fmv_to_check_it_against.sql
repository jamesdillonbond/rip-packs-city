-- 2026-10-03 beta feedback 10231 / 10233 (Detroit Pistons checklist, Joe Dumars
-- 272:9030): the "+ $62.00" on an unowned tile matched nothing the edition page
-- shows (FMV $81, low ask $148, high offer $50). The checklist's floor_usd — the
-- per-tile cost-to-add AND the header's cost-to-complete sum — was
-- fmv_snapshots.floor_price_usd, which for a sales-priced row is the minimum
-- HISTORICAL sale (schema-truth.md: "NOT a live ask … never cap anything at it").
-- Measured 2026-10-03 ~10:50 AM PT: on 6,700 Top Shot editions with both values
-- the historical floor sat BELOW the live ask on 6,067 (90.5 %), median live
-- ask / floor 1.49x; All Day 3,040 of 4,369 below, median 2.0x. So the cost a
-- collector was told to budget was systematically under what the market asks.
--
-- Fix (both functions' generic arm; the Pinnacle arms already read a live ask
-- from their catalog): floor_usd = the LIVE low ask, resolved in the same order
-- get_edition_high_offer uses for a base edition — allday_edition_floor_ask
-- (All Day only), then edition_offers.low_ask, then badge_editions.low_ask, the
-- latter two <= 7 days old — and only when it is CONNECTED to FMV (ask <= 3x
-- FMV, the estate's disconnected-ask multiple; an edition with NO FMV gets no
-- cost at all — see SECOND CUT). A troll ask or no live ask leaves floor_usd NULL so the readers'
-- existing COALESCE(floor_usd, fmv_usd) prices the tile at FMV — never at a
-- historical minimum. Under this rule the Top Shot catalogue's summed
-- cost-to-add moves $366.6K -> $421.5K (+15 %; 71 of 6,727 asks fall to FMV).
-- Cost: Lakers (497 editions) 41 ms / 7,963 buffers vs ~12 ms / 3,482 before —
-- the three ask probes are one index probe each (allday_edition_floor_ask's
-- DISTINCT ON pushes the edition_id qual down to idx_cl_v2_edition).
--
-- Readers: app/api/entity/team-checklist*, lib/fan-teams/fetchers.ts,
-- lib/entity/checklist-full-editions.ts (same COALESCE). Pin:
-- supabase/tests/get_team_checklist.sql; registration:
-- __tests__/db-invariants-drift-guard.test.ts. Same signatures -> ACLs preserved.
--
-- SECOND CUT (same hour): 20261003180241 admitted an ask whenever FMV was
-- NULL; three STALE / NO_DATA / LOW Lakers Legendaries carrying $100,000 /
-- $50,000 / $39,500 asks took the team's cost-to-complete $92.7K -> $287.4K.
-- An unpriced edition stays unpriced (floor_usd NULL, FMV NULL -> counted as
-- stale, never summed) — a lone ask with no FMV to check it against is not a
-- cost RPC can stand behind. Lakers after this cut: see the ledger.
--
-- Revert: re-apply both function bodies from
-- supabase/migrations/20260929055624_audit_20260928_pinnacle_tiles_named_by_pin.sql
-- (get_team_checklist) and
-- supabase/migrations/20260926211121_audit_20260926_pinnacle_franchise_checklist_sees_what_a_wallet_holds.sql
-- (get_team_checklist_progress), and point the pin + registration back at them.

-- anon-exec: unchanged (get_team_checklist) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
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
          btrim(pc.character_name)                            AS pin_name,
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
          s.route_slug, s.player_name, s.pin_name, s.name, s.set_name, s.set_slug, s.tier, s.tier_rank,
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
        ask.live_ask                                       AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence,
        fmv.computed_at                                    AS fmv_computed_at
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, confidence, computed_at FROM fmv_snapshots
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
            AND eo.low_ask > 0 AND eo.updated_at > now() - interval '7 days'
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

-- anon-exec: unchanged (get_team_checklist_progress) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
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
            AND eo.low_ask > 0 AND eo.updated_at > now() - interval '7 days'
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

-- Verify: both bodies carry the live-ask lateral and no longer read the
-- historical floor; the generic arm still prices through COALESCE(floor_usd, fmv_usd).
DO $verify$
DECLARE
  v_src text;
BEGIN
  FOR v_src IN
    SELECT prosrc FROM pg_proc
    WHERE proname IN ('get_team_checklist', 'get_team_checklist_progress')
      AND pronamespace = 'public'::regnamespace
  LOOP
    IF position('ask.live_ask' IN v_src) = 0 THEN
      RAISE EXCEPTION 'checklist fn missing the live-ask lateral';
    END IF;
    IF position('floor_price_usd' IN v_src) > 0 THEN
      RAISE EXCEPTION 'checklist fn still reads fmv_snapshots.floor_price_usd';
    END IF;
    IF position('fmv.fmv_usd IS NOT NULL AND a.ask <= fmv.fmv_usd * 3' IN v_src) = 0 THEN
      RAISE EXCEPTION 'checklist fn admits an ask with no FMV to check it against';
    END IF;
    IF position('COALESCE(floor_usd, fmv_usd)' IN v_src) = 0 AND position('s.floor_usd' IN v_src) = 0 THEN
      RAISE EXCEPTION 'checklist fn lost its floor_usd read';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE proname IN ('get_team_checklist', 'get_team_checklist_progress') AND pronamespace = 'public'::regnamespace) <> 2 THEN
    RAISE EXCEPTION 'expected exactly two checklist functions';
  END IF;
END
$verify$;
