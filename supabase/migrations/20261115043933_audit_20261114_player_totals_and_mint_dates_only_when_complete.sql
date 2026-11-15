-- audit_20261114_player_totals_and_mint_dates_only_when_complete
--
-- WHY (Claude Code cloud, 2026-11-14 ~8:35 PM PT; recorded by the 11-14 entity-page review, measured
-- here). get_player_detail backs /[collection]/player/[slug]'s "Total Mint" cell and its "First minted /
-- Last minted" line.
--   1. Disney Pinnacle characters the render catalog names took their minting dates from
--      pinnacle_editions by character_name. That table is SET-LEVEL and keyed by NAME, not by the pins
--      the same header counts, so the 09-27 "only when every row is dated" rule checked every row of a
--      DIFFERENT, smaller subject. Live: 23 characters published a span this way, e.g. Hamm showed one
--      date as both first and last minted from 1 row while the catalog holds 12 of his pins (Lotso 1/11,
--      The Evil Queen 1/9). The catalog carries no minting date, so the answer is none: NULL hides the line.
--   2. Every "Total Mint" was SUM(...) FILTER (WHERE x IS NOT NULL): a sum over the pins/editions whose
--      count is known, published as the total. Now NULL (rendered "—") unless every row carries one.
--      Measured: pinnacle_catalog 0 of 2,948 NULL, editions 280 of 21,472 Candy rows NULL (all with no
--      player_name, so 0 player pages today), pinnacle_editions 157 of 641 NULL (the legacy branch).
--      The sports branch's first/last-minted gets the same all-rows rule (first_minted_at is 0% populated
--      in every collection today, so this changes nothing live; it stops a future partial span).
--
-- WHAT. CREATE OR REPLACE of the live body (prosrc md5 9de2d15ed7882b61626fac60360f165f, byte-equal to
-- 20261025221903) with five exact replacements; header, SECURITY DEFINER, search_path and the 8 s
-- statement_timeout unchanged.
--
-- anon-exec: unchanged (get_player_detail) — CREATE OR REPLACE of an existing fn; ACL preserved
-- ({postgres=X/postgres,service_role=X/postgres}, anon EXECUTE false, verified live before the apply).
--
-- REVERT: re-apply the get_player_detail block of 20261025221903_audit_20261025_recent_low_totals_ignore_an_ask_far_above_fmv_a.sql.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_player_detail(uuid,text)'::regprocedure) IS DISTINCT FROM '9de2d15ed7882b61626fac60360f165f' THEN
    RAISE EXCEPTION 'get_player_detail changed since the splice base -- re-read and re-splice';
  END IF;
END
$guard$;

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
    -- header counts the pins the grid shows. The catalog carries no minting
    -- date, so this branch publishes none (2026-11-14, below).
    SELECT
      COUNT(*),
      -- 2026-11-14: a total over SOME pins is not the total. NULL unless every pin carries one.
      CASE WHEN COUNT(*) = COUNT(pc.total_minted) THEN SUM(pc.total_minted) END,
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
    -- 2026-09-27: dates only when EVERY row carries one (Mickey Mouse read
    -- "first minted" = "last minted" from 1 of 24 rows).
    -- 2026-11-14: and never from pinnacle_editions at all on this branch. That
    -- table is SET-LEVEL and keyed by NAME, not by the pins counted above, so
    -- "every row dated" was every row of a DIFFERENT, smaller subject: Hamm
    -- showed one date for both from 1 row while the catalog holds 12 of his pins
    -- (23 characters published such a span). The catalog carries no minting
    -- date, so the honest answer is none: NULL hides the line.
    v_first_minted := NULL;
    v_last_minted  := NULL;
  ELSIF p_collection_id = v_pinnacle_uuid THEN
    SELECT
      COUNT(*),
      CASE WHEN COUNT(*) = COUNT(pe.mint_count) THEN SUM(pe.mint_count) END,
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
      CASE WHEN COUNT(*) = COUNT(e.circulation_count) THEN SUM(e.circulation_count) END,
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd)) FILTER (WHERE COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd) > 0),
      CASE WHEN COUNT(*) > 0 AND COUNT(*) = COUNT(e.first_minted_at) THEN MIN(e.first_minted_at) END,
      CASE WHEN COUNT(*) > 0 AND COUNT(*) = COUNT(e.first_minted_at) THEN MAX(e.first_minted_at) END
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

DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.get_player_detail(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_player_detail became anon-executable';
  END IF;
END
$post$;
