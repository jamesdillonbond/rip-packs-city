-- Panini MLB shared cities: Los Angeles, New York and Chicago resolve to a club
-- by the athlete's own season (2026-10-23, Trevor: "Keep going"; the open item
-- from 20261023132830). Follows 20261023132904.
--
-- WHY. Panini holds no MLB club license: its baseball cards carry the CITY only
-- (2026-09-24 capture, docs/features/franchise-hubs.md). 27 cities are one club
-- each and resolve through panini_team_aliases; Los Angeles (Dodgers / Angels),
-- New York (Yankees / Mets) and Chicago (Cubs / White Sox) are two each, so the
-- six biggest-market franchise hubs could never carry Panini cards.
--
-- HOW. MLB's public Stats API (statsapi.mlb.com, reachable from the DB through
-- pg_net — measured on apply day: 200) returns, for a name, every person with
-- that name and their club per season (yearByYear splits, sport id 1 = MLB). A
-- shared-city card resolves to a club only when EXACTLY ONE of that city's two
-- clubs appears among the seasons (card year - 1 .. card year; any 2019-2022
-- season when the card carries no year) of ANY person with the athlete's name.
-- Two clubs, or none, or a name the API does not know: the label stays
-- unmapped, exactly as today. Namesakes are handled by that union, not by a
-- guess: "Will Smith" is the Dodgers catcher AND the Braves/Giants pitcher, and
-- only the Dodgers is a Los Angeles club, so a Los Angeles "Will Smith" card is
-- the catcher's.
--
--   mlb_player_lookups (name, status, people, fetched_at) — one row per name
--     asked: 'ok' (people > 0), 'none' (the API answered with no person),
--     'failed' (no 200 / unparseable). A failed lookup is retried; 'none' is a
--     measured absence.
--   mlb_player_club_seasons (name, mlb_person_id, season, mlb_team_id,
--     team_name) — the MLB (sport 1) club seasons of every person returned.
--   mlb_player_lookup_requests (request_id, name) — pg_net keeps no request log,
--     so each request's name is recorded when it is sent.
--   mlb_player_lookup_request(p_names text[]) -> the pg_net request ids, one per
--     name not already 'ok'/'none' (cap 100 per call);
--   mlb_player_lookup_collect(p_request_ids bigint[]) -> {collected, ok, none,
--     failed, pending}: parses the responses into the two tables.
--   panini_mlb_shared_city_key(city, athlete, year) -> 'MLB:<slug>' or NULL.
--   panini_resolve_team_keys_for(sport, team, athlete, year): the existing
--     resolver, then each still-unmapped shared city through the key above.
--   panini_team_listings_ingest: resolves through _for (body otherwise
--     identical — md5-checked after apply against 20261023132830's).
--   panini_reresolve_team_keys(p_sport) -> rows re-keyed: recomputes keys for
--     listings that still carry an unmapped label (a lookup or alias that
--     landed after the walk).
--   roster: Baseball 'Los Angeles', 'New York', 'Chicago'.
--
-- Revert: re-apply panini_team_listings_ingest from 20261023132830; delete the
--   three roster rows; remove the five new functions and the three tables.

CREATE TABLE IF NOT EXISTS public.mlb_player_lookups (
  name       text PRIMARY KEY,
  status     text NOT NULL CHECK (status IN ('ok', 'none', 'failed')),
  people     integer,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.mlb_player_club_seasons (
  name          text    NOT NULL,
  mlb_person_id integer NOT NULL,
  season        integer NOT NULL,
  mlb_team_id   integer NOT NULL,
  team_name     text,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, mlb_person_id, season, mlb_team_id)
);
ALTER TABLE public.mlb_player_lookups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mlb_player_club_seasons ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mlb_player_lookups, public.mlb_player_club_seasons FROM anon, authenticated;
COMMENT ON TABLE public.mlb_player_club_seasons IS
  'MLB club per season for names Panini prints (statsapi.mlb.com yearByYear, sport 1). Read by panini_mlb_shared_city_key to resolve Los Angeles / New York / Chicago Panini cards to one club. Service-role only.';

-- pg_net keeps no request log (only the queue and _http_response), so each
-- request's name is recorded here at request time; collect joins on the id.
CREATE TABLE IF NOT EXISTS public.mlb_player_lookup_requests (
  request_id   bigint PRIMARY KEY,
  name         text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mlb_player_lookup_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mlb_player_lookup_requests FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.mlb_player_lookup_request(p_names text[])
 RETURNS bigint[]
 LANGUAGE sql
 VOLATILE
 SET search_path TO 'public'
AS $function$
  WITH todo AS (
    SELECT DISTINCT btrim(x) AS name
    FROM unnest(p_names) AS x
    WHERE btrim(coalesce(x, '')) <> ''
      AND btrim(x) !~ '[|&?#%+]'
      AND NOT EXISTS (SELECT 1 FROM public.mlb_player_lookups l
                       WHERE l.name = btrim(x) AND l.status IN ('ok', 'none'))
    ORDER BY 1
    LIMIT 100
  ), sent AS (
    INSERT INTO public.mlb_player_lookup_requests (request_id, name)
    SELECT net.http_get(
             'https://statsapi.mlb.com/api/v1/people/search?names=' || replace(t.name, ' ', '%20')
               || '&hydrate=stats(group=[hitting,pitching],type=[yearByYear])',
             timeout_milliseconds := 20000),
           t.name
    FROM todo t
    RETURNING request_id
  )
  SELECT COALESCE(array_agg(request_id ORDER BY request_id), '{}') FROM sent;
$function$;

CREATE OR REPLACE FUNCTION public.mlb_player_lookup_collect(p_request_ids bigint[])
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_body jsonb;
  v_people int;
  v_ok int := 0; v_none int := 0; v_failed int := 0; v_pending int := 0; v_unknown int := 0;
BEGIN
  FOR r IN
    SELECT ids.id, req.name, resp.status_code, resp.content, resp.error_msg, resp.timed_out
    FROM unnest(p_request_ids) AS ids(id)
    LEFT JOIN public.mlb_player_lookup_requests req ON req.request_id = ids.id
    LEFT JOIN net._http_response resp ON resp.id = ids.id
  LOOP
    IF r.name IS NULL THEN
      v_unknown := v_unknown + 1;   -- not one of ours: never guess whose answer it is
      CONTINUE;
    END IF;
    IF r.status_code IS NULL AND r.error_msg IS NULL AND r.timed_out IS NOT TRUE THEN
      v_pending := v_pending + 1;
      CONTINUE;
    END IF;
    v_body := CASE WHEN r.status_code = 200 AND pg_input_is_valid(r.content, 'jsonb') THEN r.content::jsonb END;
    IF v_body IS NULL OR jsonb_typeof(v_body -> 'people') IS DISTINCT FROM 'array' THEN
      -- A failed lookup never overwrites an answered one ('ok' / 'none').
      INSERT INTO mlb_player_lookups (name, status, people, fetched_at) VALUES (r.name, 'failed', NULL, now())
      ON CONFLICT (name) DO UPDATE SET fetched_at = now()
        WHERE mlb_player_lookups.status = 'failed';
      v_failed := v_failed + 1;
      CONTINUE;
    END IF;
    v_people := jsonb_array_length(v_body -> 'people');
    INSERT INTO mlb_player_club_seasons (name, mlb_person_id, season, mlb_team_id, team_name, fetched_at)
    SELECT DISTINCT r.name, (p ->> 'id')::int, (sp ->> 'season')::int, (sp -> 'team' ->> 'id')::int, sp -> 'team' ->> 'name', now()
    FROM jsonb_array_elements(v_body -> 'people') p
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p -> 'stats', '[]'::jsonb)) st
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(st -> 'splits', '[]'::jsonb)) sp
    WHERE sp -> 'sport' ->> 'id' = '1'
      AND p ->> 'id' ~ '^\d+$'
      AND sp -> 'team' ->> 'id' ~ '^\d+$'
      AND sp ->> 'season' ~ '^\d{4}$'
    ON CONFLICT DO NOTHING;
    INSERT INTO mlb_player_lookups (name, status, people, fetched_at)
    VALUES (r.name, CASE WHEN v_people > 0 THEN 'ok' ELSE 'none' END, v_people, now())
    ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, people = EXCLUDED.people, fetched_at = now();
    IF v_people > 0 THEN v_ok := v_ok + 1; ELSE v_none := v_none + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('collected', v_ok + v_none + v_failed, 'ok', v_ok, 'none', v_none,
                            'failed', v_failed, 'pending', v_pending, 'unknown', v_unknown);
END;
$function$;

CREATE OR REPLACE FUNCTION public.panini_mlb_shared_city_key(p_city text, p_athlete text, p_year integer)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- statsapi team ids of the two clubs in each shared city -> teams_master slugs.
  WITH city_clubs(city, mlb_team_id, slug) AS (
    VALUES ('Los Angeles', 119, 'dodgers'), ('Los Angeles', 108, 'angels'),
           ('New York',    147, 'yankees'), ('New York',    121, 'mets'),
           ('Chicago',     112, 'cubs'),    ('Chicago',     145, 'white-sox')
  ), hits AS (
    SELECT DISTINCT cc.slug
    FROM mlb_player_club_seasons s
    JOIN city_clubs cc ON cc.mlb_team_id = s.mlb_team_id AND cc.city = btrim(p_city)
    WHERE s.name = btrim(p_athlete)
      AND s.season BETWEEN COALESCE(p_year - 1, 2019) AND COALESCE(p_year, 2022)
  )
  SELECT CASE WHEN (SELECT count(*) FROM hits) = 1
              THEN 'MLB:' || (SELECT slug FROM hits) END;
$function$;

CREATE OR REPLACE FUNCTION public.panini_resolve_team_keys_for(p_sport text, p_team text, p_athlete text, p_year integer)
 RETURNS TABLE(keys text[], unmapped text[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH base AS (SELECT * FROM panini_resolve_team_keys(p_sport, p_team)),
  late AS (
    SELECT u AS part,
           CASE WHEN p_sport = 'Baseball' THEN panini_mlb_shared_city_key(u, p_athlete, p_year) END AS key
    FROM base, unnest(base.unmapped) AS u
  )
  SELECT (SELECT COALESCE(array_agg(DISTINCT k ORDER BY k), '{}')
            FROM (SELECT unnest(b.keys) AS k FROM base b
                  UNION SELECT key FROM late WHERE key IS NOT NULL) q),
         (SELECT COALESCE(array_agg(part ORDER BY part), '{}') FROM late WHERE key IS NULL);
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
    CROSS JOIN LATERAL panini_resolve_team_keys_for(p_sport, s.team, s.athlete, s.genesis_year) m
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

CREATE OR REPLACE FUNCTION public.panini_reresolve_team_keys(p_sport text)
 RETURNS integer
 LANGUAGE sql
 VOLATILE
 SET search_path TO 'public'
AS $function$
  WITH upd AS (
    UPDATE panini_team_listings t
       SET franchise_keys = m.keys, unmapped_teams = m.unmapped
      FROM panini_team_listings s
      CROSS JOIN LATERAL panini_resolve_team_keys_for(s.sport, s.team_raw, s.athlete, s.genesis_year) m
     WHERE s.sku = t.sku
       AND t.sport = p_sport
       AND cardinality(t.unmapped_teams) > 0
       AND (m.keys IS DISTINCT FROM t.franchise_keys OR m.unmapped IS DISTINCT FROM t.unmapped_teams)
    RETURNING 1
  )
  SELECT count(*)::int FROM upd;
$function$;

-- anon-exec: revoked (mlb_player_lookup_request) — new function, service_role only (it issues outbound HTTP).
-- anon-exec: revoked (mlb_player_lookup_collect) — new function, service_role only (it writes).
-- anon-exec: revoked (panini_mlb_shared_city_key) — new function, service_role only like panini_resolve_team_keys.
-- anon-exec: revoked (panini_resolve_team_keys_for) — new function, service_role only like panini_resolve_team_keys.
-- anon-exec: revoked (panini_reresolve_team_keys) — new function, service_role only (it writes).
REVOKE ALL ON FUNCTION public.mlb_player_lookup_request(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mlb_player_lookup_collect(bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.panini_mlb_shared_city_key(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.panini_resolve_team_keys_for(text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.panini_reresolve_team_keys(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mlb_player_lookup_request(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.mlb_player_lookup_collect(bigint[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.panini_mlb_shared_city_key(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.panini_resolve_team_keys_for(text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.panini_reresolve_team_keys(text) TO service_role;

INSERT INTO public.panini_team_walk_targets (sport, team, enabled)
VALUES ('Baseball', 'Los Angeles', true), ('Baseball', 'New York', true), ('Baseball', 'Chicago', true)
ON CONFLICT (sport, team) DO NOTHING;
