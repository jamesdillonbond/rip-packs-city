-- 2026-09-25 (PT) — catalog search finds a player whose name carries accents
-- from the plain spelling collectors type.
--
-- WHY. The player arm matched `p.name ILIKE '%anchor%'` on the raw name, so
-- "doncic" never matched "Luka Dončić", "sengun" never matched "Alperen
-- Şengün", "schroder" never "Dennis Schröder": the query answered with 20
-- editions (whose prose is unaccented) and NO player entity. It had been
-- papered over by the accent-variant duplicate player rows ("Luka Doncic",
-- 1 edition) that 20260925101708 merged away — a search hit that led to a
-- one-Moment page for a 100-Moment player.
--
-- WHAT. Live body (== 20260814214310, md5 922c208b…) with ONE arm changed:
-- the player arm folds accents on both sides (`extensions.unaccent` on the
-- query tokens and on players.name; sim/exact/prefix on the folded pair) and
-- emits the UNACCENTED slug — the one `slugifyPlayerName` builds and the
-- page's canonical carries — instead of 'luka-don-i-'. Set, team and edition
-- arms are untouched: their predicates ride trigram indexes an unaccent()
-- wrapper would forfeit. ACL unchanged (service_role/postgres only).
-- Revert: re-apply 20260814214310.

-- anon-exec: intentional — rpc_search_catalog stays service_role/postgres-only (ACL unchanged by CREATE OR REPLACE; /api/search calls it with the service client).
CREATE OR REPLACE FUNCTION public.rpc_search_catalog(p_q text, p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
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
  -- 2026-09-25: the PLAYER arm matches with accents folded on both sides, so
  -- "doncic" finds Luka Dončić and "şengün" finds "Alperen Sengun". The other
  -- arms keep the raw query: their predicates ride trigram indexes an
  -- unaccent() wrapper would forfeit, and players is small enough not to need one.
  v_qa     text;
  v_anchor_a text;
  v_pats_a text[];
  v_n      int;
  v_need   int;
  v_limit  int  := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_pin    CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_ts     CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  IF length(v_q) < 2 THEN RETURN; END IF;

  v_tokens := array_remove(regexp_split_to_array(v_q, '\s+'), '');
  v_n := coalesce(array_length(v_tokens, 1), 0);
  IF v_n = 0 THEN RETURN; END IF;

  SELECT t INTO v_anchor FROM unnest(v_tokens) AS t ORDER BY length(t) DESC, t LIMIT 1;
  SELECT array_agg('%' || t || '%') INTO v_pats FROM unnest(v_tokens) AS t;
  v_qa := lower(btrim(extensions.unaccent(v_q)));
  v_anchor_a := lower(extensions.unaccent(v_anchor));
  SELECT array_agg('%' || lower(extensions.unaccent(t)) || '%') INTO v_pats_a FROM unnest(v_tokens) AS t;

  -- A narrative query is a DESCRIPTION, not an incantation: "lillard buzzer
  -- beater" must not return nothing merely because the prose says "buzzer" and
  -- never says "beater".
  --
  -- A 3+-token query may therefore miss ONE token. A 1- or 2-token query still
  -- must match every one: relaxing THERE would degrade "lillard buzzer" into
  -- every Lillard moment, which is a worse answer than none.
  v_need := CASE WHEN v_n >= 3 THEN v_n - 1 ELSE v_n END;

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
      AND extensions.unaccent(p.name) ILIKE '%' || v_anchor_a || '%'
      AND lower(extensions.unaccent(p.name)) LIKE ALL (v_pats_a)
    LIMIT 300
  ),
  player_hits AS (
    SELECT 'player'::text AS k,
      -- the unaccented slug is the one lib/entity-labels.ts slugifyPlayerName
      -- builds and the canonical /player/ URL carries
      regexp_replace(lower(btrim(extensions.unaccent(nm))), '[^a-z0-9]+', '-', 'g') AS sl,
      cid, min(nm) AS lbl, max(n)::int AS n, max(thumb) AS thumb,
      max(extensions.similarity(lower(extensions.unaccent(nm)), v_qa)) AS sim,
      bool_or(lower(extensions.unaccent(nm)) = v_qa) AS exact,
      bool_or(lower(extensions.unaccent(nm)) LIKE v_anchor_a || '%') AS prefix
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
  -- Candidates come from the ANCHOR alone, which is what keeps every branch
  -- trigram-index-backed (idx_editions_description_trgm for the prose arm).
  -- Token coverage is then a refinement, never an index predicate.
  edition_cand AS (
    SELECT e.id, e.external_id, e.collection_id, e.player_name, e.set_name,
           e.team_name, e.play_type, e.tier, e.thumbnail_url,
           e.circulation_count, e.description,
           lower(
             coalesce(e.player_name, '')   || ' ' ||
             coalesce(e.set_name, '')      || ' ' ||
             coalesce(e.team_name, '')     || ' ' ||
             coalesce(e.play_type, '')     || ' ' ||
             coalesce(e.play_category, '') || ' ' ||
             -- The prose is what makes a narrative query ("game winner",
             -- "buzzer beater") answerable at all.
             coalesce(e.description, '')
           ) AS combined
    FROM public.editions e
    WHERE (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      AND (e.collection_id <> v_ts OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
      AND (
        (v_q ~ '^\d+:\d+$' AND e.external_id = v_q)
        OR e.player_name ILIKE '%' || v_anchor || '%'
        OR e.set_name    ILIKE '%' || v_anchor || '%'
        OR e.team_name   ILIKE '%' || v_anchor || '%'
        OR e.description ILIKE '%' || v_anchor || '%'
      )
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
      (e.description IS NOT NULL AND tok.prose_hit >= v_need) AS via_prose,
      (tok.hit::numeric / v_n) AS cov
    FROM edition_cand e
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE e.combined LIKE pat)::int AS hit,
             count(*) FILTER (WHERE lower(coalesce(e.description, '')) LIKE pat)::int AS prose_hit
      FROM unnest(v_pats) AS pat
    ) tok
    WHERE (lower(coalesce(e.external_id, '')) = v_q) OR tok.hit >= v_need
    -- tok.hit leads the ordering so the 200-row cap can never discard a FULL
    -- match in favour of a partial one.
    ORDER BY (lower(coalesce(e.external_id, '')) = v_q) DESC,
             tok.hit DESC,
             e.circulation_count ASC NULLS LAST
    LIMIT 200
  ),
  unioned AS (
    SELECT k, lbl, NULL::text AS sub, sl, cid, thumb, n, sim, exact, prefix,
           0.35::real AS kw, 1.0::numeric AS cov FROM player_hits
    UNION ALL
    SELECT k, lbl, NULL::text, sl, cid, thumb, n, sim, exact, prefix,
           0.25::real, 1.0::numeric FROM set_hits
    UNION ALL
    SELECT k, lbl, NULL::text, sl, cid, thumb, n, sim, exact, prefix,
           0.20::real, 1.0::numeric FROM team_hits
    UNION ALL
    SELECT k, lbl,
           nullif(concat_ws(' · ', set_name, play_type, tier), ''),
           sl, cid, thumb, n, sim, exact, prefix,
           -- A prose match is a deliberate narrative hit; nudge it above the
           -- incidental name-substring editions.
           CASE WHEN via_prose THEN 0.12::real ELSE 0.00::real END,
           cov
    FROM edition_hits
  )
  SELECT u.k, u.lbl::text, u.sub::text, u.sl::text, u.cid, c.slug::text, u.thumb::text, u.n,
    (coalesce(u.sim, 0)
      + CASE WHEN u.exact THEN 1.0 ELSE 0 END
      + CASE WHEN u.prefix THEN 0.5 ELSE 0 END
      + u.kw
      -- Coverage keeps the relaxation from costing precision: a FULL match
      -- still outranks a partial one. Every entity arm is coverage 1.0, so
      -- this is a constant offset there and existing entity rankings are
      -- unmoved.
      + (u.cov * 0.60)
      + least(coalesce(u.n, 0), 500) / 5000.0
    )::real AS score
  FROM unioned u
  JOIN public.collections c ON c.id = u.cid AND c.is_active
  -- u.sl breaks the remaining ties. Editions of one player tie on score, n AND
  -- label, so without it the output order is whatever the plan happens to
  -- produce -- it visibly reshuffled between two semantically identical
  -- versions of this function while it was being verified.
  ORDER BY score DESC, u.n DESC, u.lbl ASC, u.sl ASC
  LIMIT v_limit;
END
$function$;
