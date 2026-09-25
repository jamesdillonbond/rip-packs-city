-- 2026-09-25 (PT) — Candy MLB parallels were invisible: the Rainbow colour
-- printing lives ONLY in editions.badges ("Rainbow (Blue)"), written by the
-- Solana ingest (lib/chains/solana/normalize.ts), and the unified badge reader
-- never read that column — it reads badge_editions (a Top Shot / All Day sync
-- table with zero Candy rows) and the set-name derivation. So every one of the
-- 25 Candy parallel editions rendered with no badge, and "Bobby Witt Jr. — 2026
-- MLB Base Series ICONs" was the title of SIX distinct pages (Core + five
-- colours) whose "More editions" tiles were four identical lines.
--
-- Two functions, both pinned by __tests__/db-invariants-drift-guard.test.ts:
--   1. get_edition_badges_unified gains a fourth REAL source, 'edition'
--      (editions.badges text[]), ranked after set_play and before flag, and
--      ordered after set_play in the output. Every existing pin holds: the
--      allowlist, Three-Star subsumption, dedupe precedence and the
--      derived-only-when-no-real-tags rule are untouched (an edition badge IS a
--      real tag, so it suppresses the derived fallback like the others).
--   2. get_edition_related returns a new trailing `badges text[]` column so the
--      "More from this player / set" tiles can name a parallel. Adding a
--      RETURNS TABLE column needs DROP + CREATE (42P13); the ACL is re-applied
--      in the same migration (service_role only, as before).
-- Revert: re-apply the previous defining migrations verbatim —
--   20260729000000_audit_20260729_snapshot_read_write_rpc_ddl_for_pinning.sql
--   (get_edition_badges_unified) and
--   20260907005829_audit_20260907_get_edition_related_the_edition_pages_more_from_this_player_and_set_block.sql
--   (DROP FUNCTION public.get_edition_related(uuid, int); then its CREATE + GRANTs).

-- ── 1. get_edition_badges_unified reads editions.badges ──────────────────────
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
             'id',    regexp_replace(lower(b), '[^a-z0-9]+', '-', 'g'),
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

-- ── 2. get_edition_related carries badges ────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_edition_related(uuid, integer);
-- anon-exec: intentional — get_edition_related is service_role-only (REVOKEd from PUBLIC, anon, authenticated below), read server-side by the edition page.
CREATE OR REPLACE FUNCTION public.get_edition_related(p_edition_id uuid, p_limit int DEFAULT 6)
RETURNS TABLE (
  id uuid,
  external_id text,
  player_name text,
  team_name text,
  set_name text,
  tier text,
  series smallint,
  circulation_count integer,
  thumbnail_url text,
  fmv_usd numeric,
  relation text,
  badges text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
AS $$
WITH src AS (
  SELECT e.id, e.collection_id, e.player_name, e.set_name
  FROM editions e
  WHERE e.id = p_edition_id
),
by_player AS (
  SELECT e.id, e.external_id::text, e.player_name, e.team_name, e.set_name,
         e.tier::text AS tier, e.series, e.circulation_count, e.thumbnail_url,
         f.fmv_usd, 'player'::text AS relation, e.badges
  FROM editions e
  JOIN src s ON e.collection_id = s.collection_id AND e.id <> s.id AND e.player_name = s.player_name
  LEFT JOIN LATERAL (
    SELECT fs.fmv_usd FROM fmv_snapshots fs
    WHERE fs.edition_id = e.id AND fs.computed_at > now() - interval '400 days'
    ORDER BY fs.computed_at DESC LIMIT 1
  ) f ON true
  WHERE s.player_name IS NOT NULL
    AND e.external_id IS NOT NULL
    AND e.external_id !~ '^[0-9a-f]{8}-'
  ORDER BY f.fmv_usd DESC NULLS LAST, e.circulation_count ASC NULLS LAST
  LIMIT GREATEST(p_limit, 0)
),
set_ids AS (
  SELECT e.id
  FROM editions e
  JOIN src s ON e.collection_id = s.collection_id AND e.id <> s.id AND e.set_name = s.set_name
  WHERE s.set_name IS NOT NULL
    AND e.external_id IS NOT NULL
    AND e.external_id !~ '^[0-9a-f]{8}-'
    AND e.id NOT IN (SELECT bp.id FROM by_player bp)
  ORDER BY e.circulation_count ASC NULLS LAST, e.id
  LIMIT GREATEST(p_limit, 0)
),
by_set AS (
  SELECT e.id, e.external_id::text, e.player_name, e.team_name, e.set_name,
         e.tier::text AS tier, e.series, e.circulation_count, e.thumbnail_url,
         f.fmv_usd, 'set'::text AS relation, e.badges
  FROM set_ids si
  JOIN editions e ON e.id = si.id
  LEFT JOIN LATERAL (
    SELECT fs.fmv_usd FROM fmv_snapshots fs
    WHERE fs.edition_id = e.id AND fs.computed_at > now() - interval '400 days'
    ORDER BY fs.computed_at DESC LIMIT 1
  ) f ON true
),
u AS (
  SELECT bp.*, 0 AS leg FROM by_player bp
  UNION ALL
  SELECT bs.*, 1 AS leg FROM by_set bs
)
SELECT u.id, u.external_id, u.player_name, u.team_name, u.set_name, u.tier, u.series,
       u.circulation_count, u.thumbnail_url, u.fmv_usd, u.relation, u.badges
FROM u
ORDER BY u.leg, u.fmv_usd DESC NULLS LAST, u.circulation_count ASC NULLS LAST
LIMIT GREATEST(p_limit, 0)
$$;

REVOKE ALL ON FUNCTION public.get_edition_related(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_edition_related(uuid, int) TO service_role;

-- Post-conditions.
DO $$
DECLARE v_src text; v_acl text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'get_edition_badges_unified';
  IF position('sync_edition' IN v_src) = 0 THEN RAISE EXCEPTION 'badges_unified: edition source missing'; END IF;
  SELECT pg_get_function_result(oid) INTO v_src FROM pg_proc WHERE proname = 'get_edition_related';
  IF position('badges text[]' IN v_src) = 0 THEN RAISE EXCEPTION 'get_edition_related: badges column missing (%)', v_src; END IF;
  SELECT proacl::text INTO v_acl FROM pg_proc WHERE proname = 'get_edition_related';
  IF v_acl IS NULL OR position('anon=' IN v_acl) > 0 OR position('authenticated=' IN v_acl) > 0 THEN
    RAISE EXCEPTION 'get_edition_related: ACL widened (%)', v_acl;
  END IF;
END $$;
