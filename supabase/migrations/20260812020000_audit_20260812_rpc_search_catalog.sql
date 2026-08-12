-- audit_20260812_rpc_search_catalog
--
-- The catalog had no search. Everything callable today searches ONE column
-- with an unindexed `ilike '%q%'`: /api/edition-search matches player_name
-- only (limit 10, no collection filter), /api/search-editions is auth-gated
-- for the alert modal, and every "Search…" box on a board is a client-side
-- .includes() over rows already loaded. There is no global search bar and no
-- /api/search. This function is the missing catalog index.
--
-- WHAT IT SEARCHES — and, as importantly, what it does not:
--   player  · players.name          (slug = the one /[collection]/player/[slug] resolves)
--   set     · sets.name             (slug = the one /[collection]/set/[slug] resolves)
--   team    · editions.team_name    (grouped; slug matches idx_editions_collection_team_slug)
--   edition · editions              (player + set + team + play_type + play_category)
--
-- It does NOT search descriptive prose, because none exists: `editions` has no
-- `description` column, `editions.name` is literally "<Player> — <Set>", and
-- `badges`/`reward_indicators` are empty on every row of all five collections.
-- `play_type`/`play_category` are shot mechanics (Rim, 3 Pointer, Dunk), not
-- narrative. So a query like "game winners" or "buzzer beater" legitimately
-- returns nothing — the concept is absent from the data, not from this query.
-- Do not "fix" that here; it needs a descriptive-text source first.
--
-- ENTITY ARMS RESOLVE FROM THE TABLE THE PAGE RESOLVES FROM, deliberately.
-- player/set read `players`/`sets` (not `editions`) because the detail pages
-- resolve a slug against those tables — deriving them from `editions` instead
-- would happily return a name whose page 404s. The flip side is enforced too:
-- an entity with zero editions is dropped (`n > 0`), so we never return a
-- player whose page renders empty. `players` carries duplicate rows for some
-- names (the twins noted in the deep-audit register), which collapse here via
-- GROUP BY slug — max(n) wins, so the populated twin's count is the one shown.
--
-- PINNACLE is the exception that would otherwise be silently missing: it has
-- 122 rows in `players` but ZERO rows in `editions` and ZERO in `sets`, since
-- its catalog lives in `pinnacle_catalog`. Its character counts therefore come
-- from `pinnacle_catalog`; it contributes no set/team/edition rows at all.
--
-- MULTI-TOKEN. The query is split on whitespace. The LONGEST token anchors an
-- index-backed ILIKE (idx_{editions_player_name,editions_set_name,players_name,
-- sets_name}_trgm — a GIN trgm index accelerates ILIKE '%…%'); the remaining
-- tokens are then required via LIKE ALL. Entity arms require every token in
-- the entity's OWN name, so "lillard metallic gold" matches no player (correct
-- — nobody is named that) but does match his Metallic Gold editions via the
-- edition arm, whose combined text spans player+set+team+play.
--
-- TOP SHOT DUPE RESIDUE. `editions` holds Top Shot moments under TWO key
-- conventions — integer 'setID:playID' and a UUID pair — for the SAME moment
-- (9,436 int-keyed vs 10,299 other-keyed). Left alone, every Top Shot result
-- appears TWICE (the UUID twin carrying no thumbnail) and every edition_count
-- is roughly doubled. This applies the SAME canonical predicate the trust-health
-- precompute legs and rpc_fmv_confidence_share use — Top Shot rows must match
-- '^[0-9]+:[0-9]+(::[0-9]+)?$' (the '::parallel' suffix is a real edition, not
-- residue) — so search counts the same population the accuracy metrics do. The
-- residue itself is separately watched by ts_uuid_dupes_created_24h. Non-Top-Shot
-- collections are entirely UUID-keyed and are deliberately NOT filtered.
--
-- ONE NEW INDEX. Every predicate but one rode an index that already existed
-- (verified live 2026-08-11). The exception was `editions.team_name`, which had
-- only a btree, so its ILIKE '%…%' seq-scanned all 27k rows on EVERY search:
-- adding idx_editions_team_name_trgm took the whole call 162ms -> 33ms. Built
-- CONCURRENTLY via execute_sql (editions takes catalog-backfill writes, and
-- apply_migration wraps in a transaction which CONCURRENTLY forbids), so it is
-- recorded here for the repo but is NOT applied by running this file.
-- The catalog is only ~27k editions / 3.8k players / 914 sets, so this stays
-- deliberately a query, not a materialised view.

CREATE OR REPLACE FUNCTION public.rpc_search_catalog(
  p_q             text,
  p_collection_id uuid DEFAULT NULL,
  p_limit         int  DEFAULT 20
)
RETURNS TABLE (
  kind            text,
  label           text,
  sublabel        text,
  slug            text,
  collection_id   uuid,
  collection_slug text,
  thumbnail_url   text,
  edition_count   int,
  score           real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_q      text := lower(btrim(coalesce(p_q, '')));
  v_tokens text[];
  v_anchor text;
  v_pats   text[];
  v_limit  int  := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_pin    CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_ts     CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  -- A 1-char query trigram-matches most of the catalog and is never a real
  -- intent; return empty rather than scan.
  IF length(v_q) < 2 THEN RETURN; END IF;

  v_tokens := array_remove(regexp_split_to_array(v_q, '\s+'), '');
  IF coalesce(array_length(v_tokens, 1), 0) = 0 THEN RETURN; END IF;

  SELECT t INTO v_anchor FROM unnest(v_tokens) AS t ORDER BY length(t) DESC, t LIMIT 1;
  SELECT array_agg('%' || t || '%') INTO v_pats FROM unnest(v_tokens) AS t;

  RETURN QUERY
  WITH
  player_raw AS (
    SELECT
      p.collection_id AS cid,
      p.name          AS nm,
      p.headshot_url  AS thumb,
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
    SELECT
      'player'::text AS k,
      regexp_replace(lower(btrim(nm)), '[^a-z0-9]+', '-', 'g') AS sl,
      cid,
      min(nm)          AS lbl,
      max(n)::int      AS n,
      max(thumb)       AS thumb,
      max(extensions.similarity(lower(nm), v_q))     AS sim,
      bool_or(lower(nm) = v_q)                       AS exact,
      bool_or(lower(nm) LIKE v_anchor || '%')        AS prefix
    FROM player_raw
    WHERE n > 0
    GROUP BY 1, 2, 3
  ),
  set_raw AS (
    SELECT
      s.collection_id  AS cid,
      s.name           AS nm,
      s.cover_art_url  AS thumb,
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
    SELECT
      'set'::text AS k,
      regexp_replace(lower(btrim(nm)), '[^a-z0-9]+', '-', 'g') AS sl,
      cid,
      min(nm)     AS lbl,
      max(n)::int AS n,
      max(thumb)  AS thumb,
      max(extensions.similarity(lower(nm), v_q))  AS sim,
      bool_or(lower(nm) = v_q)                    AS exact,
      bool_or(lower(nm) LIKE v_anchor || '%')     AS prefix
    FROM set_raw
    WHERE n > 0
    GROUP BY 1, 2, 3
  ),
  team_hits AS (
    SELECT
      'team'::text AS k,
      regexp_replace(lower(btrim(e.team_name)), '[^a-z0-9]+', '-', 'g') AS sl,
      e.collection_id AS cid,
      min(e.team_name) AS lbl,
      count(*)::int    AS n,
      NULL::text       AS thumb,
      max(extensions.similarity(lower(e.team_name), v_q)) AS sim,
      bool_or(lower(e.team_name) = v_q)                   AS exact,
      bool_or(lower(e.team_name) LIKE v_anchor || '%')    AS prefix
    FROM public.editions e
    WHERE (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      AND e.team_name IS NOT NULL
      AND (e.collection_id <> v_ts
           OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
      AND e.team_name ILIKE '%' || v_anchor || '%'
      AND lower(e.team_name) LIKE ALL (v_pats)
    GROUP BY 1, 2, 3
  ),
  edition_hits AS (
    SELECT
      'edition'::text AS k,
      coalesce(e.external_id, e.id::text) AS sl,
      e.collection_id AS cid,
      coalesce(e.player_name, 'Unknown') AS lbl,
      1 AS n,
      e.thumbnail_url AS thumb,
      extensions.similarity(
        lower(coalesce(e.player_name, '') || ' ' || coalesce(e.set_name, '')), v_q) AS sim,
      (lower(coalesce(e.external_id, '')) = v_q) AS exact,
      false AS prefix,
      e.set_name  AS set_name,
      e.play_type AS play_type,
      e.tier::text AS tier
    FROM public.editions e
    WHERE (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      AND (e.collection_id <> v_ts
           OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
      AND (
        -- Exact edition-key lookup ("84:2892") short-circuits the text match.
        (v_q ~ '^\d+:\d+$' AND e.external_id = v_q)
        OR (
          (e.player_name ILIKE '%' || v_anchor || '%'
            OR e.set_name ILIKE '%' || v_anchor || '%'
            OR e.team_name ILIKE '%' || v_anchor || '%')
          AND lower(
                coalesce(e.player_name, '') || ' ' ||
                coalesce(e.set_name, '')    || ' ' ||
                coalesce(e.team_name, '')   || ' ' ||
                coalesce(e.play_type, '')   || ' ' ||
                coalesce(e.play_category, '')
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
    SELECT k, lbl, NULL::text,         sl, cid, thumb, n, sim, exact, prefix, 0.25::real FROM set_hits
    UNION ALL
    SELECT k, lbl, NULL::text,         sl, cid, thumb, n, sim, exact, prefix, 0.20::real FROM team_hits
    UNION ALL
    SELECT k, lbl,
           nullif(concat_ws(' · ', set_name, play_type, tier), ''),
           sl, cid, thumb, n, sim, exact, prefix, 0.00::real
    FROM edition_hits
  )
  SELECT
    u.k,
    -- Explicit ::text on every varchar-derived column. `collections.slug` is
    -- varchar(50) and `players`/`sets`.name are varchar, so returning them raw
    -- fails the RETURNS TABLE contract with 42804 "structure of query does not
    -- match function result type" at runtime — a plpgsql RETURN QUERY checks
    -- types on execution, not at CREATE, so this cannot be caught by applying
    -- the migration alone. It has to be called.
    u.lbl::text,
    u.sub::text,
    u.sl::text,
    u.cid,
    c.slug::text,
    u.thumb::text,
    u.n,
    (coalesce(u.sim, 0)
      + CASE WHEN u.exact THEN 1.0 ELSE 0 END
      + CASE WHEN u.prefix THEN 0.5 ELSE 0 END
      + u.kw
      -- Popularity is a tiebreak only: a 5,000-edition set must not outrank an
      -- exact-name match, so it is capped at 0.1.
      + least(coalesce(u.n, 0), 500) / 5000.0
    )::real AS score
  FROM unioned u
  -- `is_active` gates PUBLISHED collections. Without it, search returns
  -- candy_mlb and panini_blockchain rows whose /[collection]/... routes do not
  -- exist (both are `published: false` in lib/collections.ts), i.e. results
  -- that 404 on click. Candy's public surface is the /insights/candy-mlb board,
  -- not a collection route, so it is correctly absent here.
  JOIN public.collections c ON c.id = u.cid AND c.is_active
  ORDER BY score DESC, u.n DESC, u.lbl ASC
  LIMIT v_limit;
END
$fn$;

COMMENT ON FUNCTION public.rpc_search_catalog(text, uuid, int) IS
  'Global catalog search across player / set / team / edition. Entity arms '
  'resolve from the table the detail page resolves from (players/sets), and '
  'drop zero-edition rows, so a hit always has a working page. Pinnacle counts '
  'come from pinnacle_catalog (it has no rows in editions/sets). Searches names '
  'and play mechanics only — the catalog holds no descriptive prose.';

-- Service-role only, read via supabaseAdmin from /api/search. The default
-- EXECUTE grant on a new function is to PUBLIC, so revoking anon/authenticated
-- alone would leave it callable via the surviving PUBLIC grant.
REVOKE EXECUTE ON FUNCTION public.rpc_search_catalog(text, uuid, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_search_catalog(text, uuid, int) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_search_catalog(text, uuid, int) TO service_role;
