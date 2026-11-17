-- ================================================================
-- qualify_unaccent_in_get_edition_badges_unified
--
-- Fixes a latent search_path bug in public.get_edition_badges_unified.
-- The function calls unaccent(...) directly but its SET search_path
-- (public, pg_temp) does not include the extensions schema where
-- unaccent now lives. Every invocation raised
--   42883: function unaccent(text) does not exist
-- which propagated to /api/badges in production and to the rpc-mcp-proxy
-- worker's get_badge_data tool. The Track C-prime fix extends the
-- search_path to (public, extensions, pg_temp) — matching the precedent
-- set by mcp_issue_api_key for SECDEF/STABLE functions that need
-- extension-namespaced functions. pg_temp stays last to preserve the
-- temp-shadow hardening.
--
-- Body is reapplied unchanged via CREATE OR REPLACE; only the search_path
-- differs from the previous definition.
-- ================================================================

create or replace function public.get_edition_badges_unified(p_edition_id uuid)
returns jsonb
language sql
stable
set search_path = public, extensions, pg_temp
as $function$
  WITH ed AS (
    SELECT e.id, e.external_id, e.collection_id, e.set_name
    FROM editions e WHERE e.id = p_edition_id
  ),
  sync_play AS (
    SELECT jsonb_array_elements(be.play_tags) AS tag, 'play' AS source
    FROM badge_editions be, ed
    WHERE be.external_id = ed.external_id AND be.collection_id = ed.collection_id
      AND jsonb_typeof(be.play_tags) = 'array'
  ),
  sync_set_play AS (
    SELECT jsonb_array_elements(be.set_play_tags) AS tag, 'set_play' AS source
    FROM badge_editions be, ed
    WHERE be.external_id = ed.external_id AND be.collection_id = ed.collection_id
      AND jsonb_typeof(be.set_play_tags) = 'array'
  ),
  sync_bool AS (
    SELECT jsonb_build_object('id','three-star-rookie','title','Three-Star Rookie') AS tag, 'flag' AS source
    FROM badge_editions be, ed
    WHERE be.external_id = ed.external_id AND be.collection_id = ed.collection_id
      AND be.is_three_star_rookie = true
    UNION ALL
    SELECT jsonb_build_object('id','rookie-mint','title','Rookie Mint'), 'flag'
    FROM badge_editions be, ed
    WHERE be.external_id = ed.external_id AND be.collection_id = ed.collection_id
      AND be.has_rookie_mint = true
  ),
  derived AS (
    SELECT jsonb_array_elements(derive_badges_from_set_name(ed.set_name)) AS tag, 'derived' AS source
    FROM ed
  ),
  all_tags AS (
    SELECT tag, source FROM sync_play
    UNION ALL SELECT tag, source FROM sync_set_play
    UNION ALL SELECT tag, source FROM sync_bool
    UNION ALL SELECT tag, source FROM derived
  ),
  -- Normalize title: lowercase + strip accents + strip non-alphanumeric.
  -- unaccent() lives in the extensions schema; this function's search_path
  -- now includes extensions so the bare call resolves.
  normalized AS (
    SELECT
      tag, source,
      regexp_replace(
        lower(unaccent(coalesce(tag->>'title', tag->>'id', ''))),
        '[^a-z0-9]+', '', 'g'
      ) AS norm_key
    FROM all_tags
    WHERE tag ? 'id' OR tag ? 'title'
  ),
  ranked AS (
    SELECT tag, source, norm_key,
      row_number() OVER (
        PARTITION BY norm_key
        ORDER BY CASE source
          WHEN 'play' THEN 1 WHEN 'set_play' THEN 2
          WHEN 'flag' THEN 3 WHEN 'derived' THEN 4
        END
      ) AS rnk
    FROM normalized
    WHERE norm_key <> ''
  )
  SELECT coalesce(
    jsonb_agg(tag || jsonb_build_object('source', source) ORDER BY
      CASE source WHEN 'flag' THEN 1 WHEN 'play' THEN 2 WHEN 'set_play' THEN 3 WHEN 'derived' THEN 4 END,
      norm_key
    ),
    '[]'::jsonb
  )
  FROM ranked WHERE rnk = 1;
$function$;
