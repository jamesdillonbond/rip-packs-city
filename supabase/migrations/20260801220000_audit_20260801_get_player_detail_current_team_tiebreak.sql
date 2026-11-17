-- audit_20260801_get_player_detail_current_team_tiebreak
--
-- WHY
-- Duplicate `players` rows (up to 32 per slug; a legitimate consequence of the
-- composite UNIQUE(external_id, collection_id) upstream key) mean get_player_detail
-- must CHOOSE which row's `team` to show on the public player page.
--
-- The prior tie-break was `team_edition_count DESC` -- the team the player has the
-- MOST moments for. For a retired player that is the right answer (Paul Pierce =>
-- Celtics, not his final Nets season). For a player who was TRADED it is the wrong
-- answer: it pins them to their highest-volume former team forever. Measured
-- 2026-08-01: 295 of 949 duplicate Top Shot slugs showed a stale team, 201 of them
-- for players still actively playing (Karl-Anthony Towns => Timberwolves not Knicks,
-- Kelsey Plum => Aces not Sparks, James Harden => Clippers not Cavaliers).
--
-- FIX
-- Prefer the player row whose `team` matches the team on the player's MOST RECENT
-- moment, but only while the player is still active. Fall back to the previous
-- ordering otherwise, so retired players keep their iconic team.
--
--   * `game_date` is the recency signal, NOT `first_minted_at`: first_minted_at is
--     0/19,583 populated on Top Shot (a dead column), so ordering by it was
--     arbitrary. game_date is 92% populated and is semantically correct -- the team
--     on a moment is the team the player was on at that game.
--   * The activity horizon is DATA-RELATIVE (max(game_date) for the collection minus
--     18 months), not a hardcoded date, so it can never go stale and it stays
--     correct for a collection whose data is frozen (e.g. a retired collection
--     still resolves "team as of end of data" rather than marking everyone
--     inactive).
--
-- The slug expression in the WHERE clause is UNCHANGED byte-for-byte so
-- idx_players_collection_name_slug still matches -- changing it would drop the page
-- back to a full collection scan (the documented pool-acquire-timeout class,
-- Sentry NEXTJS-20).
--
-- Supporting index: max(game_date) per collection was 41.8ms of the 45ms total
-- (a full scan of every edition in the collection on EVERY player page load).
-- The partial index makes it an index-only scan. editions is 26,991 rows / 38 MB,
-- so a plain (non-CONCURRENT) build is sub-second; lock_timeout guards the brief
-- ACCESS EXCLUSIVE lock on a live table.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_editions_collection_game_date
  ON public.editions (collection_id, game_date DESC)
  WHERE game_date IS NOT NULL;

RESET lock_timeout;

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
  v_first_minted     timestamptz;
  v_last_minted      timestamptz;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  WITH cand AS (
    SELECT p.*,
      (SELECT count(*) FROM editions e
         WHERE e.collection_id = p_collection_id
           AND (e.player_id = p.id OR e.player_name = p.name)
           AND e.team_name IS NOT DISTINCT FROM p.team) AS team_edition_count
    FROM players p
    WHERE p.collection_id = p_collection_id
      AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
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

  IF p_collection_id = v_pinnacle_uuid THEN
    SELECT
      COUNT(*),
      SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
      SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0),
      MIN(pe.minting_date),
      MAX(pe.minting_date)
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_first_minted, v_last_minted
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.character_name = v_player.name;
  ELSE
    SELECT
      COUNT(*),
      SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
      MIN(e.first_minted_at),
      MAX(e.first_minted_at)
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_first_minted, v_last_minted
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND (e.player_id = v_player.id OR e.player_name = v_player.name);
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
    'first_minted_at',   v_first_minted,
    'last_minted_at',    v_last_minted
  );
END;
$function$;
