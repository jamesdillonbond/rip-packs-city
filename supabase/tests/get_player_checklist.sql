-- DB invariant: public.get_player_checklist + public.get_player_checklist_progress —
-- the PLAYER checklist (beta feedback 11691, webz_80 2026-10-27; shipped 2026-10-30).
-- The team checklist's generic (Flow) arm over ONE person's editions. Claims:
--
--   1. A NAME IS NOT A PERSON: the rows are the editions linked to the player's row,
--      plus unlinked rows carrying the name — never a namesake's (player_relations),
--      the get_player_editions predicate.
--   2. owned / owned_count / owned_locked per edition for p_wallet, keyed on
--      wallet_moments_cache.edition_key = editions.external_id; no wallet → NULL.
--   3. Progress counts the same rows: total / owned / locked_owned / missing /
--      completion %, cost to complete over the rows NOT held = live ask when one is
--      ≤ 7 d old AND ≤ 3× FMV, else FMV (a troll ask falls through; an unpriced
--      edition adds nothing), per tier.
--   4. series_<n> scopes both reads to that series.
--   5. Pinnacle and an unknown slug answer the EMPTY shapes ([] / total 0), never a
--      half-built checklist.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261031044056_audit_20261031_player_checklist.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE TABLE public.players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, name text NOT NULL);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text, player_id uuid, player_name text, name text, set_name text,
  tier text, series int, circulation_count int, thumbnail_url text, video_url text, team_name text, play_type text, game_date date);
CREATE TABLE public.fmv_snapshots (edition_id uuid, fmv_usd numeric, confidence text, computed_at timestamptz);
CREATE TABLE public.wallet_moments_cache (wallet_address text, collection_id uuid, edition_key text, is_locked boolean);
CREATE TABLE public.allday_edition_floor_ask (edition_id uuid, floor_ask numeric);
CREATE TABLE public.edition_offers (collection_id uuid, external_id text, low_ask numeric, low_ask_confirmed_at timestamptz, highest_offer numeric, updated_at timestamptz);
CREATE TABLE public.badge_editions (collection_id uuid, external_id text, low_ask numeric, updated_at timestamptz);
CREATE TABLE public.collection_series (collection_id uuid, series_number int, season text);
CREATE TABLE public.player_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, player_id uuid,
  related_player_id uuid, relation text, name text, note text);
-- Copied from 20261021034822 (not itself pinned here).
CREATE OR REPLACE FUNCTION public.edition_player_is_other_person(p_edition_player_id uuid, p_page_player_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT p_edition_player_id IS NOT NULL
     AND p_edition_player_id IS DISTINCT FROM p_page_player_id
     AND EXISTS (
       SELECT 1 FROM player_relations r
        WHERE (r.relation IN ('parent_of', 'namesake')
               AND ((r.player_id = p_page_player_id AND r.related_player_id = p_edition_player_id)
                 OR (r.player_id = p_edition_player_id AND r.related_player_id = p_page_player_id)))
           OR (r.relation = 'name_change' AND r.player_id = p_edition_player_id)
     )
$function$;

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

-- Fixtures: Top Shot. Sr. (page subject), Jr. (namesake, parent_of), four of Sr.'s editions.
INSERT INTO public.players (id, collection_id, name) VALUES
  ('d0000000-0000-4000-8000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Gary Payton'),
  ('d0000000-0000-4000-8000-000000000002', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Gary Payton II');
INSERT INTO public.player_relations (collection_id, player_id, related_player_id, relation) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'parent_of');
INSERT INTO public.editions (id, collection_id, external_id, player_id, player_name, name, set_name, tier, series, circulation_count, thumbnail_url, team_name) VALUES
  -- Sr.: priced $100, live ask $120 (connected), series 1
  ('f0000000-0000-4000-8000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1', 'd0000000-0000-4000-8000-000000000001', 'Gary Payton', 'a', 'Archive', 'LEGENDARY', 1, 50, 't', 'Seattle SuperSonics'),
  -- Sr.: priced $10, live ask $900 (troll, > 3x) → costs FMV, series 1
  ('f0000000-0000-4000-8000-000000000002', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2', 'd0000000-0000-4000-8000-000000000001', 'Gary Payton', 'b', 'Archive', 'COMMON', 1, 5000, 't', 'Seattle SuperSonics'),
  -- Sr.: unlinked row carrying the name (counts), unpriced → adds nothing, series 2
  ('f0000000-0000-4000-8000-000000000003', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '2:3', NULL, 'Gary Payton', 'c', 'Throwbacks', 'RARE', 2, 400, 't', 'Seattle SuperSonics'),
  -- Sr.: priced $40, no ask, series 2 — the one the wallet HOLDS (locked)
  ('f0000000-0000-4000-8000-000000000004', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '2:4', 'd0000000-0000-4000-8000-000000000001', 'Gary Payton', 'd', 'Throwbacks', 'COMMON', 2, 3000, 't', 'Seattle SuperSonics'),
  -- Jr.: linked to Jr., NAMED like Sr. — must never land on Sr.'s checklist
  ('f0000000-0000-4000-8000-000000000005', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '7:5', 'd0000000-0000-4000-8000-000000000002', 'Gary Payton', 'e', 'Base Set', 'COMMON', 7, 8000, 't', 'Portland Trail Blazers'),
  -- Sr.: no thumbnail → excluded (the team checklist's rule)
  ('f0000000-0000-4000-8000-000000000006', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:6', 'd0000000-0000-4000-8000-000000000001', 'Gary Payton', 'f', 'Archive', 'COMMON', 1, 10, NULL, 'Seattle SuperSonics');
INSERT INTO public.fmv_snapshots VALUES
  ('f0000000-0000-4000-8000-000000000001', 100, 'HIGH', now() - interval '1 hour'),
  ('f0000000-0000-4000-8000-000000000001', 999, 'HIGH', now() - interval '2 days'),  -- older snapshot: never the one read
  ('f0000000-0000-4000-8000-000000000002', 10, 'LOW', now() - interval '1 hour'),
  ('f0000000-0000-4000-8000-000000000004', 40, 'MEDIUM', now() - interval '1 hour'),
  ('f0000000-0000-4000-8000-000000000005', 5, 'HIGH', now() - interval '1 hour');
INSERT INTO public.edition_offers VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1', 120, now() - interval '1 day', 90, now() - interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2', 900, now() - interval '1 day', NULL, now() - interval '1 day');
INSERT INTO public.wallet_moments_cache VALUES
  ('0xabc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '2:4', true),
  ('0xabc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '2:4', false),
  -- the same key in ANOTHER collection must not count (collection-scoped read)
  ('0xabc', 'dee28451-5d62-409e-a1ad-a83f763ac070', '1:1', false);

-- 1: the person, not the name. Sr.'s checklist = 1:1, 1:2, 2:3, 2:4 (highest FMV first, unpriced last); never 7:5; never the thumbnail-less 1:6.
SELECT _assert_eq(
  (SELECT string_agg(e->>'route_slug', ',' ORDER BY ord) FROM jsonb_array_elements(public.get_player_checklist('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'gary-payton')) WITH ORDINALITY t(e, ord)),
  '1:1,2:4,1:2,2:3', 'Sr. lists his own four editions, highest FMV first, unpriced last — never Jr.''s 7:5');
SELECT _assert_eq(
  (SELECT string_agg(e->>'route_slug', ',') FROM jsonb_array_elements(public.get_player_checklist('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'gary-payton-ii')) e),
  '7:5', 'Jr.''s checklist is his own edition only');
-- no wallet → owned NULL on every row
SELECT _assert_eq(
  (SELECT string_agg(COALESCE(e->>'owned', 'null'), ',') FROM jsonb_array_elements(public.get_player_checklist('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'gary-payton')) e),
  'null,null,null,null', 'no wallet → owned is NULL, never false');

-- 2: ownership + lock state for a wallet; owned rows sort LAST (missing first); collection-scoped.
SELECT _assert_eq(
  (SELECT string_agg(e->>'route_slug' || ':' || (e->>'owned') || ':' || (e->>'owned_count') || ':' || (e->>'owned_locked'), ',' ORDER BY ord)
     FROM jsonb_array_elements(public.get_player_checklist('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'gary-payton', 'all_time', '0xabc')) WITH ORDINALITY t(e, ord)),
  '1:1:false:0:false,1:2:false:0:false,2:3:false:0:false,2:4:true:2:true', 'owned / owned_count / owned_locked per edition, missing first; the All Day 1:1 row does not count');
-- the row carries the live ask + high offer the cost rule reads
SELECT _assert_eq(
  (SELECT (e->>'floor_usd') || '|' || COALESCE(e->>'high_offer_usd', 'null') FROM jsonb_array_elements(public.get_player_checklist('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'gary-payton')) e WHERE e->>'route_slug' = '1:1'),
  '120|90', 'a connected live ask and the standing high offer ride the row');
SELECT _assert(
  (SELECT e->>'floor_usd' IS NULL FROM jsonb_array_elements(public.get_player_checklist('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'gary-payton')) e WHERE e->>'route_slug' = '1:2'),
  'a troll ask (> 3x FMV) is not a floor');

-- 3: progress. anon: total 4, cost = 120 (ask) + 10 (FMV, troll ask ignored) + 40 (FMV) + nothing (unpriced) = 170.
SELECT _assert_eq(
  (SELECT p->>'total' || '|' || (p->>'owned') || '|' || (p->>'missing_count') || '|' || (p->>'cost_to_complete_usd') || '|' || (p->>'wallet_cached')
     FROM public.get_player_checklist_progress('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'gary-payton') p),
  '4|0|4|170.00|false', 'anon progress: total, nothing owned, cost = live ask where connected else FMV, unpriced adds nothing');
-- wallet: owned 1 (locked), missing 3, cost drops by the held edition''s $40, completion 25 %, by_tier per tier.
SELECT _assert_eq(
  (SELECT p->>'total' || '|' || (p->>'owned') || '|' || (p->>'locked_owned') || '|' || (p->>'missing_count') || '|' || (p->>'completion_pct') || '|' || (p->>'cost_to_complete_usd') || '|' || (p->>'wallet_cached')
     FROM public.get_player_checklist_progress('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'gary-payton', 'all_time', '0xabc') p),
  '4|1|1|3|25.0|130.00|true', 'wallet progress: owned + locked counted, cost over the missing rows only');
SELECT _assert_eq(
  (SELECT string_agg(t->>'tier' || ':' || (t->>'total') || ':' || (t->>'owned') || ':' || (t->>'cost_usd'), ',' ORDER BY ord)
     FROM jsonb_array_elements(public.get_player_checklist_progress('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'gary-payton', 'all_time', '0xabc')->'by_tier') WITH ORDINALITY t(t, ord)),
  'LEGENDARY:1:0:120.00,RARE:1:0:0.00,COMMON:2:1:10.00', 'by_tier in tier order with each tier''s own cost');

-- 4: series scope narrows both reads the same way.
SELECT _assert_eq(
  (SELECT string_agg(e->>'route_slug', ',' ORDER BY e->>'route_slug') FROM jsonb_array_elements(public.get_player_checklist('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'gary-payton', 'series_2')) e),
  '2:3,2:4', 'series_2 rows');
SELECT _assert_eq(
  (SELECT p->>'total' || '|' || (p->>'cost_to_complete_usd') FROM public.get_player_checklist_progress('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'gary-payton', 'series_2') p),
  '2|40.00', 'series_2 progress counts the same two rows');

-- 5: the empty shapes.
SELECT _assert_eq(public.get_player_checklist('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'aurora')::text, '[]', 'Pinnacle has no player checklist');
SELECT _assert_eq((public.get_player_checklist_progress('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'aurora')->>'total'), '0', 'Pinnacle progress is the zero shape');
SELECT _assert_eq(public.get_player_checklist('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nobody')::text, '[]', 'unknown slug is empty');
SELECT _assert_eq((public.get_player_checklist_progress('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nobody')->>'total') || '|' || (public.get_player_checklist_progress('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nobody')->>'by_tier'), '0|[]', 'unknown slug progress is the zero shape');

ROLLBACK;
