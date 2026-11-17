-- 2026-09-25 (PT) — the concierge's view of a player NAME. Until now every
-- concierge player tool took the label the user typed as the person: an alias
-- ("Joseph Flacco", "Stephen Curry", "Kenny Gainwell") was a catalog miss, a
-- suffix-less namesake ("Marvin Harrison", "Tim Hardaway", "Gary Payton")
-- silently resolved to whichever row spelt it that way — the FATHER, while the
-- ILIKE-filtered FMV tools pooled father and son into one distribution — and a
-- name change ("Josh Allen" the Jaguars edge rusher → Josh Hines-Allen, Robby
-- Anderson → Robbie Chosen) was invisible. Two objects fix that:
--
--  * player_relations — the facts no feed carries: who is whose parent, which
--    same-name pairs are UNRELATED, and which player has used another name.
--    Seeded with the nine parent/child pairs the catalog holds today (five
--    Top Shot, four All Day), the one unrelated pair (Byron Murphy Jr. the
--    Vikings CB vs Byron Murphy II the Seahawks DT) and the two name changes.
--    A relation is asserted here only where it is public record; a same-base-
--    name pair with NO row is reported by the resolver as "kinship not
--    recorded", never guessed.
--
--  * resolve_player_name(collection, name) → jsonb — one call that turns any
--    spelling into the person: exact → alias → the league's spelling → a
--    former name → the base name with the suffix dropped → a partial. It
--    returns 'one' with the row, its aliases, its crosswalk identity (league
--    id, ESPN id, seasons, latest team, position, whether stats exist), every
--    recorded relation, and every NAMESAKE in the collection (same base name)
--    with the relation between them; 'ambiguous' with the candidates; 'none'
--    with nothing invented. service_role only (the concierge route's client).
--
-- Also: the Bills quarterback's players.team read "Jacksonville Jaguars" — the
-- mint-time value from when the Jaguars' Josh Allen editions were labelled
-- with the same name (split 20260925232217); corrected to Buffalo Bills.
--
-- Revert: DROP FUNCTION public.resolve_player_name(uuid, text);
-- DROP TABLE public.player_relations;
-- UPDATE players SET team = 'Jacksonville Jaguars' WHERE id = (the Bills QB row).

CREATE TABLE IF NOT EXISTS public.player_relations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id     uuid NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
  player_id         uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  related_player_id uuid REFERENCES public.players(id) ON DELETE CASCADE,
  relation          text NOT NULL CHECK (relation IN ('parent_of', 'namesake', 'name_change')),
  -- name_change only: the OTHER name this person has used (former or current)
  name              text,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (relation = 'name_change' AND name IS NOT NULL AND related_player_id IS NULL)
    OR (relation <> 'name_change' AND related_player_id IS NOT NULL AND related_player_id <> player_id)
  )
);
COMMENT ON TABLE public.player_relations IS
  'Facts about players no feed carries: parent_of (player_id is the parent of related_player_id), namesake (same name, UNRELATED — recorded so the resolver can say so), name_change (name = another name this player has used). Read by resolve_player_name for the concierge. Hand-curated; public record only.';
CREATE UNIQUE INDEX IF NOT EXISTS player_relations_pair_uq
  ON public.player_relations (player_id, related_player_id, relation) WHERE related_player_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS player_relations_name_uq
  ON public.player_relations (player_id, relation, lower(name)) WHERE name IS NOT NULL;
CREATE INDEX IF NOT EXISTS player_relations_related_idx ON public.player_relations (related_player_id);
ALTER TABLE public.player_relations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_relations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.player_relations TO service_role;

-- Seed: the catalog's same-base-name pairs, each with what the public record
-- says about them, and the two name changes.
DO $$
DECLARE
  r RECORD; v_a uuid; v_b uuid;
  v_ad uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  FOR r IN SELECT * FROM (VALUES
      (v_ts, 'Gary Payton',      'Gary Payton II',       'parent_of', 'Gary Payton II is the son of Hall of Famer Gary Payton'),
      (v_ts, 'Glenn Robinson',   'Glenn Robinson III',   'parent_of', 'Glenn Robinson III is the son of Glenn Robinson ("Big Dog")'),
      (v_ts, 'Larry Nance',      'Larry Nance Jr.',      'parent_of', 'Larry Nance Jr. is the son of Larry Nance'),
      (v_ts, 'Ron Harper',       'Ron Harper Jr.',       'parent_of', 'Ron Harper Jr. is the son of Ron Harper'),
      (v_ts, 'Tim Hardaway',     'Tim Hardaway Jr.',     'parent_of', 'Tim Hardaway Jr. is the son of Tim Hardaway'),
      (v_ad, 'Antoine Winfield', 'Antoine Winfield Jr.', 'parent_of', 'Antoine Winfield Jr. is the son of Antoine Winfield'),
      (v_ad, 'Asante Samuel',    'Asante Samuel Jr.',    'parent_of', 'Asante Samuel Jr. is the son of Asante Samuel'),
      (v_ad, 'Joey Porter',      'Joey Porter Jr.',      'parent_of', 'Joey Porter Jr. is the son of Joey Porter'),
      (v_ad, 'Marvin Harrison',  'Marvin Harrison Jr.',  'parent_of', 'Marvin Harrison Jr. is the son of Hall of Famer Marvin Harrison'),
      (v_ad, 'Byron Murphy Jr.', 'Byron Murphy II',      'namesake',  'Unrelated: Byron Murphy Jr. is the cornerback (Vikings, 2019 rookie); Byron Murphy II is the defensive tackle (Seahawks, 2024 rookie)')
    ) v(coll, a_name, b_name, relation, note)
  LOOP
    SELECT id INTO v_a FROM public.players WHERE collection_id = r.coll AND name = r.a_name;
    SELECT id INTO v_b FROM public.players WHERE collection_id = r.coll AND name = r.b_name;
    IF v_a IS NULL OR v_b IS NULL THEN
      RAISE EXCEPTION 'player_relations seed: "%" / "%" not found', r.a_name, r.b_name;
    END IF;
    INSERT INTO public.player_relations (collection_id, player_id, related_player_id, relation, note)
    VALUES (r.coll, v_a, v_b, r.relation, r.note)
    ON CONFLICT DO NOTHING;
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
      (v_ad, 'Robby Anderson',   'Robbie Chosen', 'Changed his name to Robbie Chosen in 2022; All Day moments are labelled Robby Anderson'),
      (v_ad, 'Josh Hines-Allen', 'Josh Allen',    'Played as Josh Allen through 2023 and changed his name to Josh Hines-Allen in 2024 — the Jaguars edge rusher, NOT the Bills quarterback of the same name')
    ) v(coll, row_name, other_name, note)
  LOOP
    SELECT id INTO v_a FROM public.players WHERE collection_id = r.coll AND name = r.row_name;
    IF v_a IS NULL THEN RAISE EXCEPTION 'player_relations seed: "%" not found', r.row_name; END IF;
    INSERT INTO public.player_relations (collection_id, player_id, relation, name, note)
    VALUES (r.coll, v_a, 'name_change', r.other_name, r.note)
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- the Bills QB's mint-time team label
  UPDATE public.players p SET team = 'Buffalo Bills', updated_at = now()
   WHERE p.collection_id = v_ad AND p.name = 'Josh Allen' AND p.team = 'Jacksonville Jaguars'
     AND EXISTS (SELECT 1 FROM public.player_identities i WHERE i.player_id = p.id AND i.league_player_id = '00-0034857');
END $$;

-- One player, described for the concierge: row, aliases, crosswalk identity,
-- stats availability, recorded relations. Shared by the resolved case and
-- every candidate of an ambiguous one.
-- anon-exec: intentional — _player_identity_summary is an internal helper of resolve_player_name (service_role only)
CREATE OR REPLACE FUNCTION public._player_identity_summary(p_collection_id uuid, p_player_id uuid, p_query_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'player', jsonb_build_object(
      'id', p.id, 'name', p.name,
      'slug', trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')),
      'team', p.team,
      'edition_count', (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id)),
    'aliases', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('slug', a.alias_slug, 'note', a.note) ORDER BY a.alias_slug), '[]'::jsonb)
        FROM public.player_name_aliases a WHERE a.player_id = p.id),
    'identity', (
      SELECT jsonb_build_object(
        'league', i.league, 'league_player_id', i.league_player_id, 'espn_id', i.espn_id,
        'league_name', i.display_name,
        'league_name_differs', regexp_replace(lower(trim(extensions.unaccent(i.display_name))), '[^a-z0-9]+', '-', 'g')
                               <> regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g'),
        'position', i.position, 'status', i.status,
        'rookie_season', i.rookie_season, 'last_season', i.last_season, 'latest_team', i.latest_team,
        'matched_by', i.matched_by,
        'stats_seasons', (SELECT count(DISTINCT s.season) FROM public.player_season_stats s WHERE s.league = i.league AND s.espn_id = i.espn_id AND i.espn_id IS NOT NULL),
        'stats_refreshed_at', i.stats_refreshed_at)
        FROM public.player_identities i WHERE i.player_id = p.id LIMIT 1),
    'relations', (
      SELECT COALESCE(jsonb_agg(x.rel ORDER BY x.rel->>'relation', x.rel->>'name'), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object('relation', 'parent_of', 'name', o.name,
                   'slug', trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(o.name))), '[^a-z0-9]+', '-', 'g')), 'note', r.note) AS rel
            FROM public.player_relations r JOIN public.players o ON o.id = r.related_player_id
           WHERE r.player_id = p.id AND r.relation = 'parent_of'
          UNION ALL
          SELECT jsonb_build_object('relation', 'child_of', 'name', o.name,
                   'slug', trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(o.name))), '[^a-z0-9]+', '-', 'g')), 'note', r.note)
            FROM public.player_relations r JOIN public.players o ON o.id = r.player_id
           WHERE r.related_player_id = p.id AND r.relation = 'parent_of'
          UNION ALL
          SELECT jsonb_build_object('relation', 'unrelated_namesake', 'name', o.name,
                   'slug', trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(o.name))), '[^a-z0-9]+', '-', 'g')), 'note', r.note)
            FROM public.player_relations r JOIN public.players o ON o.id = CASE WHEN r.player_id = p.id THEN r.related_player_id ELSE r.player_id END
           WHERE r.relation = 'namesake' AND (r.player_id = p.id OR r.related_player_id = p.id)
          UNION ALL
          SELECT jsonb_build_object('relation', 'also_known_as', 'name', r.name,
                   'slug', trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g')), 'note', r.note)
            FROM public.player_relations r
           WHERE r.player_id = p.id AND r.relation = 'name_change'
        ) x),
    'matched_query_as', CASE
      WHEN trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')) = p_query_slug THEN 'exact'
      WHEN EXISTS (SELECT 1 FROM public.player_name_aliases a WHERE a.player_id = p.id AND a.alias_slug = p_query_slug) THEN 'alias'
      WHEN EXISTS (SELECT 1 FROM public.player_identities i WHERE i.player_id = p.id AND trim(both '-' from i.name_slug) = p_query_slug) THEN 'league_spelling'
      WHEN EXISTS (SELECT 1 FROM public.player_relations r WHERE r.player_id = p.id AND r.relation = 'name_change'
                      AND regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g') = p_query_slug) THEN 'former_name'
      WHEN regexp_replace(trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')), '-(jr|sr|ii|iii|iv|v)$', '')
           = regexp_replace(p_query_slug, '-(jr|sr|ii|iii|iv|v)$', '') THEN 'base_name'
      ELSE 'partial' END)
    FROM public.players p WHERE p.id = p_player_id;
$function$;

REVOKE ALL ON FUNCTION public._player_identity_summary(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._player_identity_summary(uuid, uuid, text) TO service_role;

-- anon-exec: intentional — resolve_player_name is service_role only (REVOKE/GRANT below);
-- the concierge route calls it with the service client
CREATE OR REPLACE FUNCTION public.resolve_player_name(p_collection_id uuid, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slug   text;
  v_base   text;
  v_suffix text;
  v_id     uuid;
  v_via    text;
  v_n      int;
  v_ids    uuid[];
  v_rows   jsonb;
  v_ns     jsonb;
  v_out    jsonb;
BEGIN
  IF p_collection_id IS NULL OR p_name IS NULL OR trim(p_name) = '' THEN
    RETURN jsonb_build_object('status', 'none', 'query', p_name, 'reason', 'empty name');
  END IF;
  v_slug := regexp_replace(lower(trim(extensions.unaccent(p_name))), '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from v_slug);
  IF v_slug = '' THEN
    RETURN jsonb_build_object('status', 'none', 'query', p_name, 'reason', 'empty name');
  END IF;
  v_base   := regexp_replace(v_slug, '-(jr|sr|ii|iii|iv|v)$', '');
  v_suffix := CASE WHEN v_base <> v_slug THEN substr(v_slug, length(v_base) + 2) END;

  -- Every row of this collection that could be meant, with its slug and base slug, once.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name, 'slug', s.slug,
                                               'base', regexp_replace(s.slug, '-(jr|sr|ii|iii|iv|v)$', ''))), '[]'::jsonb)
    INTO v_rows
    FROM public.players p
    CROSS JOIN LATERAL (SELECT trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')) AS slug) s
   WHERE p.collection_id = p_collection_id
     AND (s.slug = v_slug OR regexp_replace(s.slug, '-(jr|sr|ii|iii|iv|v)$', '') = v_base
          OR s.slug LIKE '%' || v_slug || '%'
          OR p.id IN (SELECT a.player_id FROM public.player_name_aliases a WHERE a.collection_id = p_collection_id AND a.alias_slug = v_slug)
          OR p.id IN (SELECT i.player_id FROM public.player_identities i WHERE i.collection_id = p_collection_id AND trim(both '-' from i.name_slug) = v_slug AND i.player_id IS NOT NULL)
          OR p.id IN (SELECT r.player_id FROM public.player_relations r WHERE r.collection_id = p_collection_id AND r.relation = 'name_change'
                        AND regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g') = v_slug));

  -- (1) the direct arms: exact spelling, a registered alias, the league's spelling
  SELECT array_agg(DISTINCT x.player_id) INTO v_ids
    FROM (
      SELECT t.player_id FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.slug = v_slug
      UNION
      SELECT a.player_id FROM public.player_name_aliases a WHERE a.collection_id = p_collection_id AND a.alias_slug = v_slug
      UNION
      SELECT i.player_id FROM public.player_identities i WHERE i.collection_id = p_collection_id AND trim(both '-' from i.name_slug) = v_slug AND i.player_id IS NOT NULL
    ) x;
  IF v_ids IS NOT NULL AND array_length(v_ids, 1) = 1 THEN
    v_id := v_ids[1];
    SELECT CASE WHEN EXISTS (SELECT 1 FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.player_id = v_id AND t.slug = v_slug) THEN 'exact'
                WHEN EXISTS (SELECT 1 FROM public.player_name_aliases a WHERE a.collection_id = p_collection_id AND a.alias_slug = v_slug AND a.player_id = v_id) THEN 'alias'
                ELSE 'league_spelling' END INTO v_via;
  ELSIF v_ids IS NOT NULL AND array_length(v_ids, 1) > 1 THEN
    v_via := 'conflict';
  END IF;

  -- (2) a name the person USED (a recorded name change)
  IF v_id IS NULL AND v_via IS NULL THEN
    SELECT array_agg(DISTINCT r.player_id) INTO v_ids
      FROM public.player_relations r
     WHERE r.collection_id = p_collection_id AND r.relation = 'name_change'
       AND regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g') = v_slug;
    IF v_ids IS NOT NULL AND array_length(v_ids, 1) = 1 THEN
      v_id := v_ids[1]; v_via := 'former_name';
    ELSIF v_ids IS NOT NULL THEN
      v_via := 'conflict';
    END IF;
  END IF;

  -- (3) the base name: the suffix the user typed (or omitted) decides
  IF v_id IS NULL AND v_via IS NULL THEN
    SELECT array_agg(t.player_id) INTO v_ids FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.base = v_base;
    IF v_ids IS NOT NULL THEN
      IF array_length(v_ids, 1) = 1 THEN
        v_id := v_ids[1]; v_via := 'base_name';
      ELSIF v_suffix = 'sr' THEN
        -- "X Sr." names the unsuffixed row when exactly one exists
        SELECT array_agg(t.player_id) INTO v_ids FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.base = v_base AND t.slug = t.base;
        IF v_ids IS NOT NULL AND array_length(v_ids, 1) = 1 THEN v_id := v_ids[1]; v_via := 'base_name'; ELSE v_via := 'conflict'; END IF;
      ELSE
        v_via := 'conflict';
      END IF;
    END IF;
  END IF;

  -- (4) a partial ("Lillard", "Mahomes")
  IF v_id IS NULL AND v_via IS NULL THEN
    SELECT array_agg(t.player_id) INTO v_ids FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.slug LIKE '%' || v_slug || '%';
    IF v_ids IS NOT NULL THEN
      IF array_length(v_ids, 1) = 1 THEN v_id := v_ids[1]; v_via := 'partial'; ELSE v_via := 'conflict'; END IF;
    END IF;
  END IF;

  IF v_id IS NULL AND v_via IS NULL THEN
    RETURN jsonb_build_object('status', 'none', 'query', p_name, 'query_slug', v_slug,
      'note', 'No player in this collection matches that spelling, alias, league spelling, former name, base name or partial. Do not substitute another person.');
  END IF;

  IF v_id IS NULL THEN
    -- ambiguous: describe every candidate the same way a resolved player is described
    SELECT jsonb_build_object(
             'status', 'ambiguous', 'query', p_name, 'query_slug', v_slug,
             'candidates', COALESCE(jsonb_agg(public._player_identity_summary(p_collection_id, c.player_id, v_slug) ORDER BY c.name), '[]'::jsonb),
             'note', 'Several people match — ask which one, or pick by team / era from the candidates. Never pool two people''s editions or prices into one answer.')
      INTO v_out
      FROM (SELECT DISTINCT t.player_id, t.name FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.player_id = ANY (v_ids)) c;
    RETURN v_out;
  END IF;

  SELECT COALESCE(jsonb_agg(public._player_identity_summary(p_collection_id, t.player_id, v_slug) ORDER BY t.name), '[]'::jsonb)
    INTO v_ns
    FROM (
      SELECT DISTINCT t.player_id, t.name FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text)
       WHERE t.player_id <> v_id
         AND (t.base = (SELECT b.base FROM jsonb_to_recordset(v_rows) AS b(player_id uuid, name text, slug text, base text) WHERE b.player_id = v_id LIMIT 1)
              OR t.player_id IN (SELECT r.player_id FROM public.player_relations r
                                  WHERE r.collection_id = p_collection_id AND r.relation = 'name_change'
                                    AND regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g') = v_slug)
              OR t.player_id IN (SELECT r.related_player_id FROM public.player_relations r WHERE r.player_id = v_id AND r.related_player_id IS NOT NULL)
              OR t.player_id IN (SELECT r.player_id FROM public.player_relations r WHERE r.related_player_id = v_id))
    ) t;

  v_out := public._player_identity_summary(p_collection_id, v_id, v_slug);
  RETURN jsonb_build_object('status', 'one', 'query', p_name, 'query_slug', v_slug, 'matched_via', v_via)
         || v_out
         || jsonb_build_object('namesakes', v_ns)
         || CASE WHEN jsonb_array_length(v_ns) > 0
                 THEN jsonb_build_object('note', 'Another player in this collection shares this base name (see namesakes, with the recorded relation or "kinship not recorded"). Confirm which person is meant before quoting prices, and never pool two people''s editions.')
                 ELSE '{}'::jsonb END;
END
$function$;

REVOKE ALL ON FUNCTION public.resolve_player_name(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_player_name(uuid, text) TO service_role;

-- Post-conditions on the live catalog
DO $$
DECLARE r jsonb; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.player_relations;
  IF v_n < 12 THEN RAISE EXCEPTION 'player_relations: % rows seeded, want 12', v_n; END IF;

  -- an alias resolves
  r := public.resolve_player_name('dee28451-5d62-409e-a1ad-a83f763ac070', 'Joseph Flacco');
  IF r->>'status' <> 'one' OR r->'player'->>'name' <> 'Joe Flacco' OR r->>'matched_via' <> 'alias' THEN
    RAISE EXCEPTION 'resolve_player_name: Joseph Flacco -> %', r; END IF;
  -- the father, with the son listed as a namesake and the kinship recorded
  r := public.resolve_player_name('dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison');
  IF r->>'status' <> 'one' OR r->'player'->>'name' <> 'Marvin Harrison'
     OR jsonb_array_length(r->'namesakes') <> 1 OR r->'namesakes'->0->'player'->>'name' <> 'Marvin Harrison Jr.'
     OR r->'relations'->0->>'relation' <> 'parent_of' THEN
    RAISE EXCEPTION 'resolve_player_name: Marvin Harrison -> %', r; END IF;
  -- the Bills QB, with the renamed Jaguar surfaced as a namesake via his former name
  r := public.resolve_player_name('dee28451-5d62-409e-a1ad-a83f763ac070', 'Josh Allen');
  IF r->>'status' <> 'one' OR r->'identity'->>'league_player_id' <> '00-0034857'
     OR r->'player'->>'team' <> 'Buffalo Bills'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'namesakes') n WHERE n->'player'->>'name' = 'Josh Hines-Allen') THEN
    RAISE EXCEPTION 'resolve_player_name: Josh Allen -> %', r; END IF;
  -- the league's spelling of a hand-linked legend
  r := public.resolve_player_name('dee28451-5d62-409e-a1ad-a83f763ac070', 'Mike Vick');
  IF r->>'status' <> 'one' OR r->'player'->>'name' <> 'Michael Vick' THEN
    RAISE EXCEPTION 'resolve_player_name: Mike Vick -> %', r; END IF;
  -- a partial that is unique
  r := public.resolve_player_name('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Lillard');
  IF r->>'status' <> 'one' OR r->'player'->>'name' <> 'Damian Lillard' OR r->>'matched_via' <> 'partial' THEN
    RAISE EXCEPTION 'resolve_player_name: Lillard -> %', r; END IF;
  -- nothing invented
  r := public.resolve_player_name('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Zzyzx Nobody');
  IF r->>'status' <> 'none' THEN RAISE EXCEPTION 'resolve_player_name: nobody -> %', r; END IF;
END $$;
