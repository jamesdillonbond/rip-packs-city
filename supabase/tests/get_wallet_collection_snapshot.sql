-- DB invariant: public.get_wallet_collection_snapshot — the read behind /share/[wallet]
-- and its OG card (top moments, per-collection rollup, rarest, badge count). A
-- regression mis-states a collector's public snapshot.
--
-- Pins:
--   * totalMoments / totalFmv over the wallet's wmc rows (FMV rounded, nulls -> 0);
--   * topMoments = up to 5 with fmv_usd > 0, FMV-desc (a $0/NULL moment never shows
--     as a "top" moment);
--   * badgeCount = DISTINCT badge_editions matched by the wallet's edition_keys;
--   * seriesBreakdown buckets by series number ('SUnknown' for NULL);
--   * perCollection rollup ordered by moment count desc;
--   * rarest = smallest positive mint_count (FMV-desc tiebreak);
--   * an empty wallet -> zeros / '[]' / NULL rarest, never an error.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260729000100_audit_20260729_snapshot_read_rpc_ddl_batch2.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.wallet_moments_cache (
  wallet_address text, player_name text, set_name text, tier text,
  serial_number int, edition_key text, image_url text, series_number int,
  fmv_usd numeric, mint_count int, collection_id uuid);
CREATE TABLE public.badge_editions (external_id text);
CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text, name text, market_closed_at timestamptz);

-- >>> BEGIN verbatim get_wallet_collection_snapshot (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_wallet_collection_snapshot(p_wallet text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH w AS (
    SELECT player_name, set_name, tier, serial_number, edition_key,
           image_url, series_number, fmv_usd, mint_count, collection_id
    FROM wallet_moments_cache
    WHERE wallet_address = p_wallet
  ),
  top5 AS (
    SELECT jsonb_agg(t) AS arr FROM (
      SELECT player_name AS "playerName",
             set_name    AS "setName",
             tier,
             serial_number AS serial,
             round(COALESCE(fmv_usd, 0)::numeric, 2) AS fmv,
             image_url   AS "thumbnailUrl"
      FROM w
      WHERE fmv_usd IS NOT NULL AND fmv_usd > 0
      ORDER BY fmv_usd DESC
      LIMIT 5
    ) t
  ),
  series AS (
    SELECT jsonb_object_agg(label, cnt) AS obj FROM (
      SELECT 'S' || COALESCE(series_number::text, 'Unknown') AS label,
             count(*) AS cnt
      FROM w GROUP BY 1
    ) s
  ),
  badges AS (
    SELECT count(DISTINCT be.external_id)::int AS c
    FROM badge_editions be
    WHERE be.external_id IN (SELECT DISTINCT edition_key FROM w WHERE edition_key IS NOT NULL)
  ),
  per_coll AS (
    SELECT jsonb_agg(pc ORDER BY (pc->>'moments')::int DESC) AS arr FROM (
      SELECT jsonb_build_object(
               'slug', c.slug,
               'name', c.name,
               'moments', count(*),
               -- Closed markets carry a count but no dollar total (a closed
               -- market has no current value). market_closed_at lets the UI
               -- render a "count + note" instead of a figure.
               'fmv', round(COALESCE(sum(w.fmv_usd), 0)::numeric, 2),
               'market_closed_at', c.market_closed_at
             ) AS pc
      FROM w JOIN collections c ON c.id = w.collection_id
      GROUP BY c.slug, c.name, c.market_closed_at
    ) x
  ),
  rarest AS (
    SELECT to_jsonb(r) AS obj FROM (
      SELECT player_name AS "playerName",
             set_name    AS "setName",
             tier,
             serial_number AS serial,
             mint_count  AS "mintCount",
             round(COALESCE(fmv_usd, 0)::numeric, 2) AS fmv,
             image_url   AS "thumbnailUrl"
      FROM w
      WHERE mint_count IS NOT NULL AND mint_count > 0
      ORDER BY mint_count ASC, fmv_usd DESC NULLS LAST
      LIMIT 1
    ) r
  )
  SELECT jsonb_build_object(
    'wallet', p_wallet,
    'totalMoments', (SELECT count(*)::int FROM w),
    -- Grand FMV excludes collections whose market has closed; their moments
    -- still count in totalMoments (real holdings), but their dead-market value
    -- is not folded into the headline total.
    'totalFmv', round(COALESCE((
        SELECT sum(fmv_usd) FROM w
        WHERE collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      ), 0)::numeric, 2),
    'topMoments', COALESCE((SELECT arr FROM top5), '[]'::jsonb),
    'badgeCount', COALESCE((SELECT c FROM badges), 0),
    'seriesBreakdown', COALESCE((SELECT obj FROM series), '{}'::jsonb),
    'perCollection', COALESCE((SELECT arr FROM per_coll), '[]'::jsonb),
    'rarest', (SELECT obj FROM rarest)
  );
$function$;
-- <<< END verbatim get_wallet_collection_snapshot <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''

INSERT INTO public.collections (id, slug, name) VALUES
  (:TS::uuid, 'nba_top_shot', 'NBA Top Shot'),
  (:PIN::uuid, 'disney_pinnacle', 'Disney Pinnacle');

INSERT INTO public.wallet_moments_cache (wallet_address, player_name, set_name, tier, serial_number, edition_key, image_url, series_number, fmv_usd, mint_count, collection_id) VALUES
  ('W','Dame',  'Base','RARE',  5,  'k1','i1', 4,   100,  500, :TS::uuid),
  ('W','Ant',   'Base','COMMON',10, 'k2','i2', 4,    50, 1000, :TS::uuid),
  ('W','Mickey','Pin', 'CHASER',1,  'k3','i3', NULL,  0,   25, :PIN::uuid),  -- fmv 0 (not "top"), rarest by mint
  ('W','X',     'Base','COMMON',3,  'k4','i4', 4,  NULL, NULL, :TS::uuid);   -- null fmv/mint

-- badges match k1 + k3 only.
INSERT INTO public.badge_editions (external_id) VALUES ('k1'), ('k3');

-- ── 1. totals ────────────────────────────────────────────────────────────────
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'totalMoments'), '4', 'totalMoments = 4');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'totalFmv'), '150.00', 'totalFmv = 150.00 (nulls ignored)');

-- ── 2. topMoments: only fmv>0, desc ──────────────────────────────────────────
SELECT _assert_eq(jsonb_array_length(public.get_wallet_collection_snapshot('W') -> 'topMoments')::text, '2', 'topMoments has 2 (fmv>0 only)');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') -> 'topMoments' -> 0 ->> 'playerName'), 'Dame', 'top moment is highest FMV (Dame)');

-- ── 3. badgeCount = distinct matched edition_keys ────────────────────────────
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'badgeCount'), '2', 'badgeCount = 2 (k1,k3)');

-- ── 4. seriesBreakdown buckets (SUnknown for null series) ────────────────────
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') -> 'seriesBreakdown' ->> 'S4'), '3', 'series S4 = 3');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') -> 'seriesBreakdown' ->> 'SUnknown'), '1', 'null series -> SUnknown = 1');

-- ── 5. perCollection ordered by moment count desc ────────────────────────────
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') -> 'perCollection' -> 0 ->> 'slug'), 'nba_top_shot', 'perCollection[0] = Top Shot (3 moments)');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') -> 'perCollection' -> 0 ->> 'moments'), '3', 'Top Shot moment count = 3');

-- ── 6. rarest = smallest positive mint ───────────────────────────────────────
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') -> 'rarest' ->> 'playerName'), 'Mickey', 'rarest = smallest mint (Mickey, 25)');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') -> 'rarest' ->> 'mintCount'), '25', 'rarest mintCount = 25');

-- ── 7. empty wallet -> zeros / [] / null rarest ──────────────────────────────
SELECT _assert_eq((public.get_wallet_collection_snapshot('none') ->> 'totalMoments'), '0', 'empty wallet -> 0 moments');
SELECT _assert_eq((public.get_wallet_collection_snapshot('none') -> 'topMoments')::text, '[]', 'empty wallet -> [] topMoments');
SELECT _assert_eq((public.get_wallet_collection_snapshot('none') ->> 'badgeCount'), '0', 'empty wallet -> 0 badges');
SELECT _assert((public.get_wallet_collection_snapshot('none') -> 'rarest') = 'null'::jsonb OR (public.get_wallet_collection_snapshot('none') ->> 'rarest') IS NULL, 'empty wallet -> null rarest');

-- ── 8. closed-market exclusion (2026-08-03): a closed collection's moments still
--      COUNT (real holdings) but its dead-market value is excluded from totalFmv,
--      and perCollection carries market_closed_at so the UI renders a count+note.
UPDATE public.collections SET market_closed_at = now() WHERE slug = 'nba_top_shot';
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'totalMoments'), '4', 'closed market still counts moments (totalMoments stays 4)');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'totalFmv'), '0.00', 'closed Top Shot FMV excluded from totalFmv (only Pinnacle $0 remains)');
SELECT _assert((SELECT (pc ->> 'market_closed_at') IS NOT NULL FROM jsonb_array_elements(public.get_wallet_collection_snapshot('W') -> 'perCollection') pc WHERE pc ->> 'slug' = 'nba_top_shot'), 'perCollection Top Shot carries market_closed_at');

SELECT '✓ get_wallet_collection_snapshot: all assertions passed' AS result;

ROLLBACK;
