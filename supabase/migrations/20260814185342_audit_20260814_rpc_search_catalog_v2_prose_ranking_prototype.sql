-- PROTOTYPE ONLY — nothing calls this. Created as a SEPARATE function so the
-- live rpc_search_catalog (public header search + concierge search_catalog) is
-- untouched while the prose-ranking change is measured side by side.
--
-- Change vs v1, and ONLY this: the edition arm's prose contribution stops being
-- a flat `via_prose -> 0.12` flag and becomes graded AND exclusivity-gated.
--
-- Measured problem it targets: a row whose description literally contains the
-- query scored 0.1404, while a fuzzy NAME match with no prose at all scored
-- 0.4676 (a player hit also collects the 0.35 kind-weight). And because the
-- boost was flat, every prose hit tied and ordered alphabetically.
--
-- ⚠ THE EXCLUSIVITY GATE IS LOAD-BEARING. Boosting any description match would
-- regress ordinary name search: querying "lillard" would lift every edition
-- whose prose merely MENTIONS him to near the Lillard PLAYER hit. The boost
-- applies only when the phrase is absent from every name field, i.e. when the
-- match is genuinely narrative and nothing else explains it.
--
-- ⚠ This does NOT fix stemming. `48:1652` says "game-winning" and is EXCLUDED
-- by the LIKE ALL token predicate for "game winner" — a different defect that
-- needs full-text search. Do not claim this fixes narrative search generally.
CREATE OR REPLACE FUNCTION public.rpc_search_catalog_v2(p_q text, p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
 RETURNS TABLE(kind text, label text, sublabel text, slug text, collection_id uuid, collection_slug text, thumbnail_url text, edition_count integer, score real)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_q      text := lower(btrim(coalesce(p_q, '')));
  v_tokens text[];
  v_anchor text;
  v_pats   text[];
  v_limit  int  := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_pin    CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_ts     CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  IF length(v_q) < 2 THEN RETURN; END IF;

  v_tokens := array_remove(regexp_split_to_array(v_q, '\s+'), '');
  IF coalesce(array_length(v_tokens, 1), 0) = 0 THEN RETURN; END IF;

  SELECT t INTO v_anchor FROM unnest(v_tokens) AS t ORDER BY length(t) DESC, t LIMIT 1;
  SELECT array_agg('%' || t || '%') INTO v_pats FROM unnest(v_tokens) AS t;

  RETURN QUERY
  WITH
  player_raw AS (
    SELECT
      p.collection_id AS cid, p.name AS nm, p.headshot_url AS thumb,
      CASE
        WHEN p.collection_id = v_pin
          THEN (SELECT count(*) FROM public.pinnacle_catalog pc WHERE pc.character_name = p.name)
        ELSE (SELECT count(*) FROM public.editions e
                WHERE e.collection_id = p.collection_id
                  AND (e.player_id = p.id OR e.player_name = p.name)
                  AND (e.collection_id <> v_ts
                       OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'))
      END AS n
    FROM public.players p
    WHERE (p_collection_id IS NULL OR p.collection_id = p_collection_id)
      AND p.name ILIKE '%' || v_anchor || '%'
      AND lower(p.name) LIKE ALL (v_pats)
    LIMIT 300
  ),
  player_hits AS (
    SELECT 'player'::text AS k,
      regexp_replace(lower(btrim(nm)), '[^a-z0-9]+', '-', 'g') AS sl,
      cid, min(nm) AS lbl, max(n)::int AS n, max(thumb) AS thumb,
      max(extensions.similarity(lower(nm), v_q)) AS sim,
      bool_or(lower(nm) = v_q) AS exact,
      bool_or(lower(nm) LIKE v_anchor || '%') AS prefix
    FROM player_raw WHERE n > 0 GROUP BY 1, 2, 3
  ),
  set_raw AS (
    SELECT s.collection_id AS cid, s.name AS nm, s.cover_art_url AS thumb,
      (SELECT count(*) FROM public.editions e
         WHERE e.collection_id = s.collection_id
           AND (e.set_id = s.id OR e.set_name = s.name)
           AND (e.collection_id <> v_ts
                OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')) AS n
    FROM public.sets s
    WHERE (p_collection_id IS NULL OR s.collection_id = p_collection_id)
      AND s.name ILIKE '%' || v_anchor || '%'
      AND lower(s.name) LIKE ALL (v_pats)
    LIMIT 300
  ),
  set_hits AS (
    SELECT 'set'::text AS k,
      regexp_replace(lower(btrim(nm)), '[^a-z0-9]+', '-', 'g') AS sl,
      cid, min(nm) AS lbl, max(n)::int AS n, max(thumb) AS thumb,
      max(extensions.similarity(lower(nm), v_q)) AS sim,
      bool_or(lower(nm) = v_q) AS exact,
      bool_or(lower(nm) LIKE v_anchor || '%') AS prefix
    FROM set_raw WHERE n > 0 GROUP BY 1, 2, 3
  ),
  team_hits AS (
    SELECT 'team'::text AS k,
      regexp_replace(lower(btrim(e.team_name)), '[^a-z0-9]+', '-', 'g') AS sl,
      e.collection_id AS cid, min(e.team_name) AS lbl, count(*)::int AS n,
      NULL::text AS thumb,
      max(extensions.similarity(lower(e.team_name), v_q)) AS sim,
      bool_or(lower(e.team_name) = v_q) AS exact,
      bool_or(lower(e.team_name) LIKE v_anchor || '%') AS prefix
    FROM public.editions e
    WHERE (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      AND e.team_name IS NOT NULL
      AND (e.collection_id <> v_ts OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
      AND e.team_name ILIKE '%' || v_anchor || '%'
      AND lower(e.team_name) LIKE ALL (v_pats)
    GROUP BY 1, 2, 3
  ),
  edition_hits AS (
    SELECT 'edition'::text AS k,
      coalesce(e.external_id, e.id::text) AS sl,
      e.collection_id AS cid,
      coalesce(e.player_name, 'Unknown') AS lbl,
      1 AS n,
      e.thumbnail_url AS thumb,
      extensions.similarity(
        lower(coalesce(e.player_name, '') || ' ' || coalesce(e.set_name, '')), v_q) AS sim,
      (lower(coalesce(e.external_id, '')) = v_q) AS exact,
      false AS prefix,
      e.set_name AS set_name, e.play_type AS play_type, e.tier::text AS tier,
      (e.description IS NOT NULL
        AND lower(e.description) LIKE ALL (v_pats)) AS via_prose,
      -- NEW: the whole query appears verbatim in the prose.
      (e.description IS NOT NULL
        AND position(v_q in lower(e.description)) > 0) AS prose_phrase,
      -- NEW: the exclusivity gate. If the phrase is already in a NAME field,
      -- this is an ordinary name match and must not be boosted as narrative.
      (position(v_q in lower(
         coalesce(e.player_name, '') || ' ' ||
         coalesce(e.set_name, '')    || ' ' ||
         coalesce(e.team_name, ''))) > 0) AS phrase_in_name
    FROM public.editions e
    WHERE (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      AND (e.collection_id <> v_ts OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
      AND (
        (v_q ~ '^\d+:\d+$' AND e.external_id = v_q)
        OR (
          (e.player_name ILIKE '%' || v_anchor || '%'
            OR e.set_name ILIKE '%' || v_anchor || '%'
            OR e.team_name ILIKE '%' || v_anchor || '%'
            OR e.description ILIKE '%' || v_anchor || '%')
          AND lower(
                coalesce(e.player_name, '') || ' ' ||
                coalesce(e.set_name, '')    || ' ' ||
                coalesce(e.team_name, '')   || ' ' ||
                coalesce(e.play_type, '')   || ' ' ||
                coalesce(e.play_category, '') || ' ' ||
                coalesce(e.description, '')
              ) LIKE ALL (v_pats)
        )
      )
    ORDER BY (lower(coalesce(e.external_id, '')) = v_q) DESC,
             e.circulation_count ASC NULLS LAST
    LIMIT 200
  ),
  unioned AS (
    SELECT k, lbl, NULL::text AS sub, sl, cid, thumb, n, sim, exact, prefix, 0.35::real AS kw FROM player_hits
    UNION ALL
    SELECT k, lbl, NULL::text, sl, cid, thumb, n, sim, exact, prefix, 0.25::real FROM set_hits
    UNION ALL
    SELECT k, lbl, NULL::text, sl, cid, thumb, n, sim, exact, prefix, 0.20::real FROM team_hits
    UNION ALL
    SELECT k, lbl,
           nullif(concat_ws(' · ', set_name, play_type, tier), ''),
           sl, cid, thumb, n, sim, exact, prefix,
           CASE
             -- Genuinely narrative: the phrase is in the prose and in NO name.
             WHEN via_prose AND prose_phrase AND NOT phrase_in_name THEN 0.55::real
             -- All tokens present in prose (but not as a contiguous phrase).
             WHEN via_prose AND NOT phrase_in_name               THEN 0.25::real
             -- Prose matches but a name does too: ordinary hit, v1 behaviour.
             WHEN via_prose                                       THEN 0.12::real
             ELSE 0.00::real
           END
    FROM edition_hits
  )
  SELECT u.k, u.lbl::text, u.sub::text, u.sl::text, u.cid, c.slug::text, u.thumb::text, u.n,
    (coalesce(u.sim, 0)
      + CASE WHEN u.exact THEN 1.0 ELSE 0 END
      + CASE WHEN u.prefix THEN 0.5 ELSE 0 END
      + u.kw
      + least(coalesce(u.n, 0), 500) / 5000.0
    )::real AS score
  FROM unioned u
  JOIN public.collections c ON c.id = u.cid AND c.is_active
  ORDER BY score DESC, u.n DESC, u.lbl ASC
  LIMIT v_limit;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.rpc_search_catalog_v2(text, uuid, integer) FROM PUBLIC, anon, authenticated;