-- 2026-09-25 (PT) — follow-up to 20260925084253: the 'edition'-source badge id
-- kept a trailing hyphen ("Rainbow (Blue)" -> "rainbow-blue-") because the
-- closing parenthesis became a separator. Trim separators at both ends. Title,
-- source, ordering and every other pin are unchanged; this is the file the
-- drift guard pins get_edition_badges_unified to.
-- Revert: re-apply 20260925084253 verbatim.

-- anon-exec: intentional — get_edition_badges_unified is a public READ helper already executable by anon (ACL untouched by CREATE OR REPLACE); it is called by get_edition_detail on every anon edition page.
CREATE OR REPLACE FUNCTION public.get_edition_badges_unified(p_edition_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  WITH ed AS (
    SELECT e.id, e.external_id,
           split_part(e.external_id::text, '::', 1) AS base_external_id,
           e.collection_id, e.set_name, e.badges
    FROM editions e WHERE e.id = p_edition_id
  ),
  be_row AS (
    SELECT be.*
    FROM badge_editions be
    JOIN ed ON be.external_id = ed.base_external_id AND be.collection_id = ed.collection_id
    LIMIT 1
  ),
  sync_play AS (
    SELECT pt.tag, 'play' AS source
    FROM be_row be
    CROSS JOIN LATERAL jsonb_array_elements(be.play_tags) AS pt(tag)
    WHERE jsonb_typeof(be.play_tags) = 'array'
      AND regexp_replace(
            lower(unaccent(coalesce(pt.tag->>'title', pt.tag->>'id', ''))),
            '[^a-z0-9]+', '', 'g'
          ) = ANY (ARRAY[
            'topshotdebut','rookieyear','rookiemint','rookiepremiere',
            'mvpyear','championshipyear','rookieoftheyear','allstar',
            'threestarrookie'
          ])
  ),
  sync_set_play AS (
    SELECT jsonb_array_elements(be.set_play_tags) AS tag, 'set_play' AS source
    FROM be_row be
    WHERE jsonb_typeof(be.set_play_tags) = 'array'
  ),
  sync_mint AS (
    SELECT jsonb_build_object('id','rookie-mint','title','Rookie Mint') AS tag, 'flag' AS source
    FROM be_row be
    WHERE be.has_rookie_mint = true
  ),
  -- 2026-09-25: badges the INGEST wrote onto the edition row itself
  -- (editions.badges text[]). Candy MLB carries its Rainbow parallel here
  -- ("Rainbow (Blue)") and nowhere else — badge_editions is a Top Shot / All Day
  -- sync table with no Candy rows — so until now every Candy parallel rendered
  -- with no badge and five colour printings read as the same edition.
  sync_edition AS (
    SELECT jsonb_build_object(
             'id',    btrim(regexp_replace(lower(b), '[^a-z0-9]+', '-', 'g'), '-'),
             'title', b
           ) AS tag, 'edition' AS source
    FROM ed
    CROSS JOIN LATERAL unnest(coalesce(ed.badges, '{}'::text[])) AS b
    WHERE btrim(coalesce(b, '')) <> ''
  ),
  -- real synced tags (excluding the derived-from-Three-Star injection below)
  real_tags AS (
    SELECT tag, source FROM sync_play
    UNION ALL SELECT tag, source FROM sync_set_play
    UNION ALL SELECT tag, source FROM sync_mint
    UNION ALL SELECT tag, source FROM sync_edition
  ),
  -- v2 Three-Star rule: Rookie Year + Rookie Mint + Rookie Premiere present.
  flags AS (
    SELECT
      bool_or(regexp_replace(lower(unaccent(coalesce(tag->>'title',tag->>'id',''))),'[^a-z0-9]+','','g')='rookieyear')     AS has_year,
      bool_or(regexp_replace(lower(unaccent(coalesce(tag->>'title',tag->>'id',''))),'[^a-z0-9]+','','g')='rookiepremiere') AS has_premiere,
      bool_or(regexp_replace(lower(unaccent(coalesce(tag->>'title',tag->>'id',''))),'[^a-z0-9]+','','g')='rookiemint')     AS has_mint
    FROM real_tags
  ),
  tsr AS (
    SELECT (
      COALESCE((SELECT is_three_star_rookie FROM be_row), false)
      OR COALESCE((SELECT has_year AND has_premiere AND has_mint FROM flags), false)
    ) AS v
  ),
  sync_tsr AS (
    SELECT jsonb_build_object('id','three-star-rookie','title','Three-Star Rookie') AS tag, 'flag' AS source
    FROM tsr WHERE tsr.v = true
  ),
  combined_real AS (
    SELECT tag, source FROM real_tags
    UNION ALL SELECT tag, source FROM sync_tsr
  ),
  derived AS (
    SELECT jsonb_array_elements(derive_badges_from_set_name(ed.set_name)) AS tag, 'derived' AS source
    FROM ed
  ),
  all_tags AS (
    SELECT tag, source FROM combined_real
    UNION ALL
    SELECT tag, source FROM derived
    WHERE NOT EXISTS (SELECT 1 FROM combined_real)
  ),
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
          WHEN 'play' THEN 1 WHEN 'set_play' THEN 2 WHEN 'edition' THEN 3
          WHEN 'flag' THEN 4 WHEN 'derived' THEN 5
        END
      ) AS rnk
    FROM normalized
    WHERE norm_key <> ''
  ),
  has_tsr AS (
    SELECT EXISTS (SELECT 1 FROM ranked WHERE rnk = 1 AND norm_key = 'threestarrookie') AS v
  )
  SELECT coalesce(
    jsonb_agg(
      (CASE
         WHEN norm_key = 'codenamemercury'
           THEN (tag - 'title') || jsonb_build_object('title', 'Leaderboard Reward')
         ELSE tag
       END) || jsonb_build_object('source', source)
      ORDER BY
        CASE source WHEN 'flag' THEN 1 WHEN 'play' THEN 2 WHEN 'set_play' THEN 3 WHEN 'edition' THEN 4 WHEN 'derived' THEN 5 END,
        norm_key
    ),
    '[]'::jsonb
  )
  FROM ranked, has_tsr
  WHERE rnk = 1
    -- Three-Star Rookie subsumes Rookie Year + Rookie Mint + Rookie Premiere; hide
    -- those standalone badges when it is present (Top Shot Debut stays separate).
    AND NOT (has_tsr.v AND norm_key IN ('rookieyear','rookiepremiere','rookiemint'));
$function$;

DO $$
DECLARE v_id text;
BEGIN
  SELECT prosrc INTO v_id FROM pg_proc WHERE proname = 'get_edition_badges_unified';
  IF position('btrim(regexp_replace(lower(b)' IN v_id) = 0 THEN RAISE EXCEPTION 'trim did not land'; END IF;
END $$;
