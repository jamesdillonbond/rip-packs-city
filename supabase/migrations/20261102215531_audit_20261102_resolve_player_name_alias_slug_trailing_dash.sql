-- audit_20261102_resolve_player_name_alias_slug_trailing_dash
--
-- #221 follow-up (rule 2). resolve_player_name trims '-' from the QUERY slug, and
-- player_identities.name_slug is compared trimmed too — but player_name_aliases
-- stores the SITE slug, where a trailing "." keeps its dash ("kenyon-martin-jr-").
-- The alias arm compared it untrimmed, missed, and the suffix-drop arm then named
-- the FATHER: resolve_player_name(<Top Shot>, 'Kenyon Martin Jr.') returned Kenyon
-- Martin (Nuggets) while every "Kenyon Martin Jr." edition belongs to KJ Martin
-- (players dc1cbe93…, alias kenyon-martin-jr-). Measured 2026-11-02: 5 aliases end
-- in '-'; the other 4 (All Day Robinson/Slay/James/Etienne) resolved right only
-- because their base name has no namesake.
--
-- Fix: the three alias comparisons trim '-' from alias_slug, as the identity arm
-- already does. Base: 20260926011020 (live prosrc md5
-- dcb708631072e5f20c231018273267d3 = that file's body, verified 2026-11-02
-- immediately before writing). Nothing else in the body changes.
--
-- anon-exec: unchanged (service_role only) — CREATE OR REPLACE preserves the ACL (resolve_player_name)
--
-- REVERT: DELETE FROM public.player_relations WHERE note LIKE 'KJ Martin (Kenyon Martin Jr.)%'; then re-apply the resolve_player_name block of
--   supabase/migrations/20260926011020_audit_20260925_player_relations_and_resolve_player_name_for_the_concierge.sql

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
          OR p.id IN (SELECT a.player_id FROM public.player_name_aliases a WHERE a.collection_id = p_collection_id AND trim(both '-' from a.alias_slug) = v_slug)
          OR p.id IN (SELECT i.player_id FROM public.player_identities i WHERE i.collection_id = p_collection_id AND trim(both '-' from i.name_slug) = v_slug AND i.player_id IS NOT NULL)
          OR p.id IN (SELECT r.player_id FROM public.player_relations r WHERE r.collection_id = p_collection_id AND r.relation = 'name_change'
                        AND regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g') = v_slug));

  -- (1) the direct arms: exact spelling, a registered alias, the league's spelling
  SELECT array_agg(DISTINCT x.player_id) INTO v_ids
    FROM (
      SELECT t.player_id FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.slug = v_slug
      UNION
      SELECT a.player_id FROM public.player_name_aliases a WHERE a.collection_id = p_collection_id AND trim(both '-' from a.alias_slug) = v_slug
      UNION
      SELECT i.player_id FROM public.player_identities i WHERE i.collection_id = p_collection_id AND trim(both '-' from i.name_slug) = v_slug AND i.player_id IS NOT NULL
    ) x;
  IF v_ids IS NOT NULL AND array_length(v_ids, 1) = 1 THEN
    v_id := v_ids[1];
    SELECT CASE WHEN EXISTS (SELECT 1 FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.player_id = v_id AND t.slug = v_slug) THEN 'exact'
                WHEN EXISTS (SELECT 1 FROM public.player_name_aliases a WHERE a.collection_id = p_collection_id AND trim(both '-' from a.alias_slug) = v_slug AND a.player_id = v_id) THEN 'alias'
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

-- Rule 2: record the father/son pair the resolver could not see (Top Shot).
-- KJ Martin (Kenyon Martin Jr.) is the son of Kenyon Martin. Idempotent.
INSERT INTO public.player_relations (collection_id, player_id, related_player_id, relation, note)
SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', f.id, s.id, 'parent_of',
       'KJ Martin (Kenyon Martin Jr.) is the son of Kenyon Martin (#221, 2026-11-02)'
  FROM public.players f, public.players s
 WHERE f.id = 'e386ce5b-5e69-4cf7-9cfb-6ee72e5b4dd1' AND f.name = 'Kenyon Martin'
   AND s.id = 'dc1cbe93-2326-401b-842c-948a3149b287' AND s.name = 'KJ Martin'
   AND NOT EXISTS (SELECT 1 FROM public.player_relations r
                    WHERE r.player_id = f.id AND r.related_player_id = s.id AND r.relation = 'parent_of');
