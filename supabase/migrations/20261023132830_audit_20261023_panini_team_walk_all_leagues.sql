-- Panini team walk reaches every league a franchise hub covers (2026-10-23,
-- Trevor: "Do it all", after the 10-22 franchise-hub Panini panel). Part 1 of 2.
--
-- WHY. The Panini panel on /teams/<league>/<slug> reads panini_team_listings,
-- which the laptop team walk fills — and its roster was 30 NBA teams + Detroit
-- (the 09-24 pilot). So only NBA hubs (and the Tigers) can show Panini cards,
-- though the catalogue holds 10,937 football, 3,719 women's-basketball and
-- 732 baseball Panini editions.
--
-- THIS PART (no constraint change, safe against the laptop's CURRENT script):
--   · roster: the 23 single-club MLB cities not yet on it, each already a
--     panini_team_aliases row (Panini's MLB cards carry the CITY only;
--     Los Angeles / New York / Chicago are two clubs each and stay off until a
--     player->club resolver exists — 2026-09-24 capture, franchise-hubs.md).
--   · panini_team_walk_plan_for(limit, sports): the plan filtered to the sports
--     the CALLER can walk. ⚠ Load-bearing: the laptop script keeps only
--     Basketball/Baseball rows, and the plan hands out never-attempted rows
--     first — so football rows reaching the OLD script would be dropped
--     client-side, never stamped, stay stalest forever and starve the whole
--     rotation. /api/cron/panini-team-walk passes ['Basketball','Baseball']
--     unless the walker names its sports (the new script does).
--   · panini_resolve_team_keys: Football and Womens Basketball labels resolve
--     through league_team_abbr (current AND historic names — 43 NFL / 21 WNBA,
--     all resolving, measured on apply day), so "Oakland Raiders" maps to
--     NFL:raiders. Basketball/Baseball arms unchanged.
--   · panini_team_listings_ingest: accepts the four sports (the table CHECK,
--     widened in part 2, still guards the write). Body otherwise identical.
--
-- Revert: re-apply panini_resolve_team_keys from 20260924141618 and
--   panini_team_listings_ingest from 20260925034001; remove the function
--   panini_team_walk_plan_for(integer, text[]) and the 23 roster rows
--   (sport = 'Baseball' AND team <> 'Detroit').

-- anon-exec: unchanged (panini_resolve_team_keys) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false authenticated=false.
CREATE OR REPLACE FUNCTION public.panini_resolve_team_keys(p_sport text, p_team text)
 RETURNS TABLE(keys text[], unmapped text[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH parts AS (
    SELECT DISTINCT btrim(x) AS part
    FROM unnest(string_to_array(coalesce(p_team, ''), '|')) AS x
    WHERE btrim(x) <> ''
  ), res AS (
    SELECT p.part,
           COALESCE(
             (SELECT a.league::text || ':' || a.team_slug FROM panini_team_aliases a
               WHERE a.sport = p_sport AND a.raw_team = p.part),
             CASE WHEN p_sport = 'Basketball' THEN
               (SELECT tm.league::text || ':' || tm.slug FROM teams_master tm
                 WHERE tm.league IN ('NBA','WNBA') AND tm.active AND tm.team_name = p.part
                 ORDER BY tm.league LIMIT 1)
             -- 2026-10-23: current AND historic names via the franchise registry.
             WHEN p_sport IN ('Football', 'Womens Basketball') THEN
               (SELECT tm.league::text || ':' || tm.slug
                  FROM league_team_abbr(CASE p_sport WHEN 'Football' THEN 'nfl' ELSE 'wnba' END) l
                  JOIN teams_master tm
                    ON tm.active
                   AND tm.league::text = CASE p_sport WHEN 'Football' THEN 'NFL' ELSE 'WNBA' END
                   AND tm.abbreviation = l.abbr
                 WHERE l.team_name = p.part
                 ORDER BY tm.slug LIMIT 1)
             END
           ) AS key
    FROM parts p
  )
  SELECT COALESCE(array_agg(DISTINCT key) FILTER (WHERE key IS NOT NULL), '{}'),
         COALESCE(array_agg(part ORDER BY part) FILTER (WHERE key IS NULL), '{}')
  FROM res;
$function$;

-- anon-exec: unchanged (panini_team_listings_ingest) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false authenticated=false.
CREATE OR REPLACE FUNCTION public.panini_team_listings_ingest(p_sport text, p_team_raw text, p_walk_started_at timestamp with time zone, p_rows jsonb, p_complete boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_written int := 0;
  v_mapped int := 0;
  v_unmapped int := 0;
  v_retired int := 0;
  v_seen int := 0;
  v_active int := 0;
  v_retire_skipped boolean := false;
BEGIN
  IF p_sport NOT IN ('Basketball','Baseball','Football','Womens Basketball') THEN
    RAISE EXCEPTION 'panini_team_listings_ingest: unsupported sport %', p_sport;
  END IF;
  IF coalesce(btrim(p_team_raw), '') = '' OR p_walk_started_at IS NULL THEN
    RAISE EXCEPTION 'panini_team_listings_ingest: team and walk start are required';
  END IF;

  WITH src AS (
    SELECT DISTINCT ON (r->>'sku')
           r->>'sku' AS sku, r->>'psku' AS psku, nullif(r->>'team', '') AS team,
           r->>'athlete' AS athlete, r->>'cardset' AS cardset,
           CASE WHEN r->>'genesis_year' ~ '^\d{4}$' THEN (r->>'genesis_year')::int END AS genesis_year,
           r->>'rarity' AS rarity,
           CASE WHEN r->>'end_seq' ~ '^\d+$' THEN (r->>'end_seq')::int END AS end_seq,
           CASE WHEN r->>'price_usd' ~ '^\d+(\.\d+)?$' THEN (r->>'price_usd')::numeric END AS price_usd,
           r->>'nft_type' AS nft_type
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) AS r
    WHERE coalesce(r->>'sku', '') <> '' AND coalesce(r->>'psku', '') <> ''
    ORDER BY r->>'sku'
  ), up AS (
    INSERT INTO panini_team_listings AS t
      (sku, psku, sport, walk_team, team_raw, franchise_keys, unmapped_teams, athlete, cardset,
       set_id, genesis_year, rarity, end_seq, price_usd, nft_type, active, first_seen_at, last_seen_at, retired_at)
    SELECT s.sku, s.psku, p_sport, p_team_raw, s.team, m.keys, m.unmapped, s.athlete, s.cardset,
           split_part(s.psku, '_', 1), s.genesis_year, s.rarity, s.end_seq, s.price_usd, s.nft_type,
           true, now(), now(), NULL
    FROM src s
    CROSS JOIN LATERAL panini_resolve_team_keys(p_sport, s.team) m
    ON CONFLICT (sku) DO UPDATE SET
      psku = EXCLUDED.psku, sport = EXCLUDED.sport, walk_team = EXCLUDED.walk_team,
      team_raw = EXCLUDED.team_raw, franchise_keys = EXCLUDED.franchise_keys,
      unmapped_teams = EXCLUDED.unmapped_teams, athlete = EXCLUDED.athlete, cardset = EXCLUDED.cardset,
      set_id = EXCLUDED.set_id, genesis_year = EXCLUDED.genesis_year, rarity = EXCLUDED.rarity,
      end_seq = EXCLUDED.end_seq, price_usd = EXCLUDED.price_usd, nft_type = EXCLUDED.nft_type,
      active = true, last_seen_at = now(), retired_at = NULL
    RETURNING cardinality(t.franchise_keys) > 0 AS is_mapped
  )
  SELECT count(*), count(*) FILTER (WHERE is_mapped), count(*) FILTER (WHERE NOT is_mapped)
    INTO v_written, v_mapped, v_unmapped
  FROM up;

  -- A listing this complete walk did not see is no longer listed. Scoped to the same
  -- (sport, walk_team), and never on a partial walk (the caller passes p_complete only
  -- when the grid ended in an empty page AND every earlier flush landed).
  --
  -- ⚠ AND NEVER WHEN THE WALK SAW LESS THAN HALF OF WHAT IS ACTIVE. The end-of-list
  -- signal is an empty page, and Panini has answered a live team's page 1 with an
  -- empty list (Hawks + Jazz, 2026-09-24, 30 listings each minutes later). The walker
  -- now re-reads an empty page before believing it; this is the second, independent
  -- net: a "complete" walk that saw < 50 % of the team's active listings retires
  -- nothing and says so (retire_skipped), and the walker reports the run ok=false.
  IF p_complete THEN
    SELECT count(*) FILTER (WHERE last_seen_at >= p_walk_started_at), count(*)
      INTO v_seen, v_active
      FROM panini_team_listings
     WHERE sport = p_sport AND walk_team = p_team_raw AND active;
    IF v_active > 0 AND v_seen * 2 < v_active THEN
      v_retire_skipped := true;
    ELSE
      UPDATE panini_team_listings
         SET active = false, retired_at = now()
       WHERE sport = p_sport AND walk_team = p_team_raw AND active
         AND last_seen_at < p_walk_started_at;
      GET DIAGNOSTICS v_retired = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object('written', v_written, 'mapped', v_mapped, 'unmapped', v_unmapped, 'retired', v_retired,
                            'retire_skipped', v_retire_skipped, 'seen', v_seen, 'active_before', v_active);
END;
$function$;

CREATE OR REPLACE FUNCTION public.panini_team_walk_plan_for(p_limit integer, p_sports text[])
 RETURNS TABLE(sport text, team text, last_complete_at timestamp with time zone, last_attempt_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT t.sport, t.team, t.last_complete_at, t.last_attempt_at
  FROM panini_team_walk_targets t
  WHERE t.enabled
    AND t.sport = ANY (COALESCE(p_sports, ARRAY['Basketball','Baseball']))
  ORDER BY t.last_attempt_at ASC NULLS FIRST, t.last_complete_at ASC NULLS FIRST, t.sport, t.team
  LIMIT greatest(1, least(coalesce(p_limit, 5), 50));
$function$;

-- anon-exec: revoked (panini_team_walk_plan_for) — new function, service_role only like panini_team_walk_plan; the receiver route calls it via supabaseAdmin.
REVOKE ALL ON FUNCTION public.panini_team_walk_plan_for(integer, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_team_walk_plan_for(integer, text[]) TO service_role;

INSERT INTO public.panini_team_walk_targets (sport, team, enabled)
SELECT 'Baseball', a.raw_team, true
FROM public.panini_team_aliases a
WHERE a.sport = 'Baseball'
ON CONFLICT (sport, team) DO NOTHING;
