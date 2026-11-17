-- audit_20261031_player_checklist — 2026-10-30 ~9:45 PM PT applied (Cowork cloud, autonomous pass).
--
-- Beta feedback 11691 (webz_80, 2026-10-27, on the Nuggets team page): "in addition to team
-- checklists, a player checklist might be a fun addition" — every edition one player has, scored
-- owned vs missing for a pasted wallet, with a cost to complete, like the team checklist.
--
-- Two new RPCs, the PLAYER twins of get_team_checklist / get_team_checklist_progress:
--   get_player_checklist(p_collection_id, p_player_slug, p_scope, p_wallet, p_limit, p_offset) -> jsonb rows
--   get_player_checklist_progress(p_collection_id, p_player_slug, p_scope, p_wallet)          -> jsonb header
-- The player is resolved the way get_player_editions resolves it (players row by slug, accent-
-- folded), and an edition belongs to that PERSON by the same predicate get_player_editions uses:
-- `e.player_id = v_player.id OR (e.player_name = v_player.name AND NOT edition_player_is_other_person(...))`
-- — a name is not a person (CLAUDE.md concierge rule 2), so a namesake's editions never land here.
-- Scope (all_time / contemporary / series_<n>), the live-ask cost rule (<= 7 d, <= 3x FMV, FMV
-- required), high_offer_usd, owned / owned_count / owned_locked and the progress aggregates are the
-- team functions' generic (Flow) arm VERBATIM except for the WHERE. Pinnacle has no player checklist:
-- its "players" are characters on a render catalog with no series/season, so both return the empty
-- shape there (rows [] / progress total 0) rather than a half-built one.
--
-- ⚠ Copy count: the live-ask block and the season CASE now exist in FOUR functions
-- (get_team_checklist, get_team_checklist_progress and these two). A change to either rule must
-- grep for `a.ask <= fmv.fmv_usd * 3` and `WHEN 9 THEN 2026` and land in all four.
--
-- anon-exec: revoked (get_player_checklist) — new fn; REVOKE FROM PUBLIC, anon, authenticated below; verified anon=false post-apply.
-- anon-exec: revoked (get_player_checklist_progress) — new fn; REVOKE FROM PUBLIC, anon, authenticated below; verified anon=false post-apply.
-- REVERT: DROP FUNCTION public.get_player_checklist(uuid, text, text, text, integer, integer);
--         DROP FUNCTION public.get_player_checklist_progress(uuid, text, text, text);

CREATE OR REPLACE FUNCTION public.get_player_checklist(p_collection_id uuid, p_player_slug text, p_scope text DEFAULT 'all_time'::text, p_wallet text DEFAULT NULL::text, p_limit integer DEFAULT 60, p_offset integer DEFAULT 0)
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
  v_player        RECORD;
  result          jsonb;
BEGIN
  IF p_scope ~ '^series_[0-9]+$' THEN
    v_series_filter := substring(p_scope from 8)::int;
  END IF;

  -- Pinnacle "players" are characters on a render catalog (no series / season); no player checklist there.
  IF p_collection_id = v_pinnacle_uuid THEN RETURN '[]'::jsonb; END IF;

  -- The PERSON, the way get_player_editions resolves it (slug, accent-folded).
  SELECT p.* INTO v_player
  FROM players p
  WHERE p.collection_id = p_collection_id
    AND (regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
           OR regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = p_player_slug)
  LIMIT 1;
  IF v_player IS NULL THEN RETURN '[]'::jsonb; END IF;

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
      (CASE WHEN p_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN
        (SELECT NULLIF(regexp_replace(cs.season, '[^0-9]', '', 'g'), '')::int
           FROM collection_series cs
          WHERE cs.collection_id = p_collection_id AND cs.series_number = e.series)
      ELSE (CASE e.series
        WHEN 0 THEN 2019 WHEN 1 THEN 2019 WHEN 2 THEN 2020 WHEN 3 THEN 2021
        WHEN 4 THEN 2021 WHEN 5 THEN 2022 WHEN 6 THEN 2023 WHEN 7 THEN 2024
        WHEN 8 THEN 2025 WHEN 9 THEN 2026 ELSE NULL END) END)                  AS series_season,
      (CASE WHEN e.game_date IS NULL THEN NULL
            WHEN EXTRACT(month FROM e.game_date) >= (CASE WHEN p_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN 3 ELSE 8 END)
              THEN EXTRACT(year FROM e.game_date)::int
            ELSE EXTRACT(year FROM e.game_date)::int - 1 END) AS play_season,
      fmv.fmv_usd,
      ask.live_ask                                       AS floor_usd,
      hi.high_offer_usd,
      fmv.confidence::text                               AS fmv_confidence,
      fmv.computed_at                                    AS fmv_computed_at
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, confidence, computed_at FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
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
    LEFT JOIN LATERAL (
      SELECT eo.highest_offer AS high_offer_usd
      FROM edition_offers eo
      WHERE eo.collection_id = e.collection_id AND eo.external_id = e.external_id
        AND eo.highest_offer > 0 AND eo.updated_at > now() - interval '7 days'
    ) hi ON true
    WHERE e.collection_id = p_collection_id
      AND (e.player_id = v_player.id OR (e.player_name = v_player.name AND NOT public.edition_player_is_other_person(e.player_id, v_player.id)))
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
      s.fmv_usd, s.floor_usd, s.high_offer_usd, s.fmv_confidence, s.fmv_computed_at,
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

  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_player_checklist_progress(p_collection_id uuid, p_player_slug text, p_scope text DEFAULT 'all_time'::text, p_wallet text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_series_filter int := NULL;
  v_player        RECORD;
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

  IF p_collection_id <> v_pinnacle_uuid THEN
    SELECT p.* INTO v_player
    FROM players p
    WHERE p.collection_id = p_collection_id
      AND (regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
             OR regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = p_player_slug)
    LIMIT 1;
  END IF;
  IF v_player IS NULL THEN
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
        (SELECT NULLIF(regexp_replace(cs.season, '[^0-9]', '', 'g'), '')::int
           FROM collection_series cs
          WHERE cs.collection_id = p_collection_id AND cs.series_number = e.series)
      ELSE (CASE e.series
        WHEN 0 THEN 2019 WHEN 1 THEN 2019 WHEN 2 THEN 2020 WHEN 3 THEN 2021
        WHEN 4 THEN 2021 WHEN 5 THEN 2022 WHEN 6 THEN 2023 WHEN 7 THEN 2024
        WHEN 8 THEN 2025 WHEN 9 THEN 2026 ELSE NULL END) END) AS series_season,
      (CASE WHEN e.game_date IS NULL THEN NULL
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
      AND (e.player_id = v_player.id OR (e.player_name = v_player.name AND NOT public.edition_player_is_other_person(e.player_id, v_player.id)))
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

  RETURN result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_player_checklist(uuid, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_player_checklist_progress(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_player_checklist(uuid, text, text, text, integer, integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.get_player_checklist_progress(uuid, text, text, text) TO postgres, service_role;

COMMENT ON FUNCTION public.get_player_checklist(uuid, text, text, text, integer, integer) IS
  'Player checklist rows (beta feedback 11691, 2026-10-30): every edition of ONE person in a collection, owned / owned_count / owned_locked for p_wallet; the team checklist''s generic arm with the get_player_editions person predicate. Pinnacle: []. Service-role only; read by /api/entity/team-checklist?entity=player.';
COMMENT ON FUNCTION public.get_player_checklist_progress(uuid, text, text, text) IS
  'Player checklist header (beta feedback 11691, 2026-10-30): total / owned / locked / completion / cost to complete (live ask <= 3x FMV, else FMV) / by_tier for ONE person. Pinnacle: the zero shape. Service-role only; read by /api/entity/team-checklist-progress?entity=player.';
