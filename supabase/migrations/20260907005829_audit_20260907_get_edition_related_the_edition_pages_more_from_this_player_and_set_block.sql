-- audit_20260907: get_edition_related — the edition page's "More <player> / More
-- from <set>" block (Search Console pass, 2026-09-06/07).
--
-- WHY. Search Console's internal-link report is inverted: the footer links
-- (/pricing 27,566) dominate while each of the ~30K entity pages gets one link
-- from its parent. The edition page — now the canonical target of every
-- /moment/<edition uuid> 308 — linked to ZERO other editions (measured live on
-- /nba-top-shot/edition/99:3372). This function returns up to p_limit sibling
-- editions: the same player's other editions first (FMV desc), then the same
-- set's scarcest editions to fill. Team highlights (player_name = team_name)
-- get the team's other highlights the same way.
--
-- COST (BUFFERS, measured before writing): worst player (LeBron, 179 editions)
-- 1,033 buffers / 5 ms; worst set (a 4,866-edition Top Shot set, team Moment)
-- ~2,270 buffers / 12 ms. The set leg picks ids by circulation BEFORE the
-- per-edition FMV lookup, so the lateral runs p_limit times, never thousands.
-- Inert UUID-keyed edition rows are excluded by shape.
--
-- REVERT: DROP FUNCTION public.get_edition_related(uuid, int);

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
  relation text
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
         f.fmv_usd, 'player'::text AS relation
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
         f.fmv_usd, 'set'::text AS relation
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
       u.circulation_count, u.thumbnail_url, u.fmv_usd, u.relation
FROM u
ORDER BY u.leg, u.fmv_usd DESC NULLS LAST, u.circulation_count ASC NULLS LAST
LIMIT GREATEST(p_limit, 0)
$$;

REVOKE ALL ON FUNCTION public.get_edition_related(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_edition_related(uuid, int) TO service_role;