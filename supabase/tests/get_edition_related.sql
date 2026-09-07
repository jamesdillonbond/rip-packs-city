-- DB invariant: public.get_edition_related — the edition page's "More from this
-- player / set" block (Search Console pass, 2026-09-07). Given an edition it
-- returns up to p_limit SIBLING editions in the same collection: the same
-- player's other editions first (FMV desc), then the same set's scarcest
-- editions to fill. This is the block that gives every edition page its
-- outbound edition links, so a regression here silently removes the site's
-- entity-to-entity internal linking again.
--
-- Pins:
--   * the source edition itself is never returned; other collections never are;
--   * inert UUID-keyed edition rows (external_id shaped like a uuid) are excluded;
--   * the player leg comes first, FMV desc, NULL FMV last;
--   * the set leg fills only what the player leg left, scarcest circulation
--     first, with no duplicates across legs;
--   * a source with no player_name (a bare team highlight) gets the set leg only;
--   * a team Moment (player_name = team_name) matches its team's other Moments
--     through the player leg;
--   * p_limit 0 and an unknown edition both return zero rows (never an error).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260907005829_audit_20260907_get_edition_related_the_edition_pages_more_from_this_player_and_set_block.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures (only the columns the function reads) ────────────────────
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, external_id varchar, player_name text,
  team_name text, set_name text, tier text, series smallint, circulation_count integer,
  thumbnail_url text);
CREATE TABLE public.fmv_snapshots (edition_id uuid, computed_at timestamptz, fmv_usd numeric);

-- >>> BEGIN verbatim get_edition_related (keep byte-identical to the migration) >>>
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
-- <<< END verbatim get_edition_related <<<

-- ── fixtures ──────────────────────────────────────────────────────────────────
-- Collection A: player P has 4 canonical editions (+1 inert uuid-keyed dupe);
-- set S has those plus 3 non-P editions of varying scarcity. Collection B has a
-- P edition that must never appear.
INSERT INTO public.editions (id, collection_id, external_id, player_name, team_name, set_name, tier, series, circulation_count, thumbnail_url) VALUES
  ('00000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '1:1',  'P', 'T', 'S', 'COMMON', 1, 1000, NULL), -- the SOURCE
  ('00000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '1:2',  'P', 'T', 'S', 'RARE',   1,  500, NULL),
  ('00000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', '2:3',  'P', 'T', 'S2','COMMON', 1, 8000, NULL),
  ('00000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', '3:4',  'P', 'T', 'S3','LEGENDARY', 1, 50, NULL),
  ('00000000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'a1b2c3d4-0000-4000-8000-000000000005', 'P', 'T', 'S', 'COMMON', 1, 1, NULL), -- inert uuid-keyed dupe
  ('00000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111', '1:6',  'Q', 'T', 'S', 'COMMON', 1,  300, NULL),
  ('00000000-0000-4000-8000-000000000007', '11111111-1111-4111-8111-111111111111', '1:7',  'R', 'U', 'S', 'COMMON', 1,   40, NULL),
  ('00000000-0000-4000-8000-000000000008', '11111111-1111-4111-8111-111111111111', '1:8',  'W', 'U', 'S', 'COMMON', 1, 9000, NULL),
  ('00000000-0000-4000-8000-000000000009', '22222222-2222-4222-8222-222222222222', '9:9',  'P', 'T', 'S', 'COMMON', 1,   10, NULL), -- other collection
  -- a bare team highlight (no player_name) in set S, and two team Moments
  ('00000000-0000-4000-8000-000000000010', '11111111-1111-4111-8111-111111111111', '1:10', NULL, 'T', 'S', 'COMMON', 1, 700, NULL),
  ('00000000-0000-4000-8000-000000000011', '11111111-1111-4111-8111-111111111111', '5:11', 'Kings', 'Kings', 'Clamps', 'COMMON', 1, 100, NULL),
  ('00000000-0000-4000-8000-000000000012', '11111111-1111-4111-8111-111111111111', '5:12', 'Kings', 'Kings', 'Clamps', 'COMMON', 1, 200, NULL);

INSERT INTO public.fmv_snapshots (edition_id, computed_at, fmv_usd) VALUES
  ('00000000-0000-4000-8000-000000000002', now() - interval '1 day', 40),
  ('00000000-0000-4000-8000-000000000002', now() - interval '9 days', 999), -- stale, must lose to the fresh row
  ('00000000-0000-4000-8000-000000000003', now() - interval '1 day', 5),
  ('00000000-0000-4000-8000-000000000004', now() - interval '1 day', 300),
  ('00000000-0000-4000-8000-000000000005', now() - interval '1 day', 5000), -- on the inert dupe: must never surface
  ('00000000-0000-4000-8000-000000000009', now() - interval '1 day', 5000);

-- ── assertions ────────────────────────────────────────────────────────────────

-- 1. Player leg first, FMV desc (latest snapshot wins), then the set fill,
--    scarcest first; never self, never the inert dupe, never another collection.
SELECT _assert_eq(
  (SELECT string_agg(external_id || '/' || relation || '/' || coalesce(fmv_usd::text, '-'), ',' ORDER BY ord)
     FROM (SELECT external_id, relation, fmv_usd, row_number() OVER () AS ord
             FROM get_edition_related('00000000-0000-4000-8000-000000000001', 6)) r),
  '3:4/player/300,1:2/player/40,2:3/player/5,1:7/set/-,1:6/set/-,1:10/set/-',
  'player leg (FMV desc) then set fill (scarcest first), no self / dupe / foreign rows');

-- 2. p_limit bounds the whole result, player leg first.
SELECT _assert_eq(
  (SELECT string_agg(external_id, ',' ORDER BY ord)
     FROM (SELECT external_id, row_number() OVER () AS ord
             FROM get_edition_related('00000000-0000-4000-8000-000000000001', 2)) r),
  '3:4,1:2', 'p_limit 2 keeps the two best player-leg rows');

-- 3. A source with no player_name gets the set leg only (and never itself).
--    The set leg PICKS by scarcity (1:7, 1:6, 1:2 — 1:8 at 9000 is cut) and then
--    the final order puts priced editions first, so 1:2 (FMV 40) leads.
SELECT _assert_eq(
  (SELECT string_agg(external_id || '/' || relation, ',' ORDER BY ord)
     FROM (SELECT external_id, relation, row_number() OVER () AS ord
             FROM get_edition_related('00000000-0000-4000-8000-000000000010', 3)) r),
  '1:2/set,1:7/set,1:6/set', 'no player_name → set leg only: the 3 scarcest are picked, then priced ones lead');

-- 4. A team Moment (player_name = team_name) finds its team's other Moments.
SELECT _assert_eq(
  (SELECT string_agg(external_id || '/' || relation, ',')
     FROM get_edition_related('00000000-0000-4000-8000-000000000011', 6)),
  '5:12/player', 'team Moment matches the team through the player leg');

-- 5. Zero rows, not an error, for p_limit 0 and for an unknown edition.
SELECT _assert((SELECT count(*) FROM get_edition_related('00000000-0000-4000-8000-000000000001', 0)) = 0, 'p_limit 0 → zero rows');
SELECT _assert((SELECT count(*) FROM get_edition_related('99999999-9999-4999-8999-999999999999', 6)) = 0, 'unknown edition → zero rows');

-- 6. The inert uuid-keyed row never appears even though it carries the highest FMV.
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM get_edition_related('00000000-0000-4000-8000-000000000002', 10) WHERE external_id LIKE 'a1b2c3d4%'),
  'uuid-keyed inert edition rows are excluded');

ROLLBACK;
