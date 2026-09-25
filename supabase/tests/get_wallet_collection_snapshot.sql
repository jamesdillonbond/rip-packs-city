-- DB invariant: public.get_wallet_collection_snapshot — the read behind /share/[wallet]
-- and its OG card (top moments, per-collection rollup, rarest, badge count). A
-- regression mis-states a collector's public snapshot.
--
-- Pins:
--   * totalMoments / totalFmv over the wallet's wmc rows (FMV rounded, nulls -> 0);
--   * topMoments = up to 5 with fmv_usd > 0, FMV-desc (a $0/NULL moment never shows
--     as a "top" moment);
--   * badgeCount = DISTINCT badge_editions matched by the wallet's edition_keys;
--   * series bars (2026-09-24/25): the wallet's LARGEST collection only, labelled by
--     series_display_label, one bar per LABEL (on-chain 0 and stored 1 are both
--     Top Shot "Series 1"); another collection's series never leaks in;
--   * perCollection rollup ordered by moment count desc;
--   * rarest = smallest positive mint_count (FMV-desc tiebreak);
--   * an empty wallet -> zeros / '[]' / NULL rarest, never an error.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260925182927_audit_20260925_share_snapshot_stale_count_pairs_with_stale_fmv.sql);
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
-- 2026-09-04/06 (20260904045817, 20260906174634): the stale split reads each
-- holding's CURRENT FMV confidence through editions → edition_fmv_current.
CREATE TABLE public.editions (id uuid PRIMARY KEY, external_id text, collection_id uuid);
CREATE TABLE public.edition_fmv_current (edition_id uuid, confidence text);
CREATE TABLE public.collection_series (id int, collection_id uuid, series_number int, display_label text, season text);

-- series_display_label: VERBATIM from production (pg_get_functiondef, 2026-09-25,
-- prosrc md5 d97398150bdf8a1cce5bb3ee91c14de4). Called by the body since 20260925062018.
CREATE OR REPLACE FUNCTION public.series_display_label(p_collection_id uuid, p_series integer)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_label  text;
  v_season text;
  v_slug   text;
BEGIN
  IF p_series IS NULL THEN RETURN NULL; END IF;

  SELECT c.slug INTO v_slug FROM public.collections c WHERE c.id = p_collection_id;

  SELECT cs.display_label, cs.season INTO v_label, v_season
  FROM public.collection_series cs
  WHERE cs.collection_id = p_collection_id
    AND (
      cs.series_number = p_series
      OR (v_slug = 'disney_pinnacle' AND cs.season = p_series::text)
    )
  ORDER BY (cs.series_number = p_series) DESC
  LIMIT 1;

  -- Top Shot retired the ordinal after Series 4. The repo map and
  -- collection_series disagree on the ORDINAL for on-chain 6/7/8 (open — see
  -- CLAUDE.md) but AGREE on the season, so the season form is the answer that
  -- does not take a side, and it reproduces lib/series-label.ts exactly.
  IF v_slug = 'nba_top_shot' AND p_series >= 6 AND v_season IS NOT NULL THEN
    RETURN 'Series ' || v_season;
  END IF;

  IF v_label IS NULL OR btrim(v_label) = '' THEN
    RETURN 'Series ' || p_series::text;
  END IF;

  IF v_label ~ '^[0-9]' THEN
    RETURN 'Series ' || v_label;
  END IF;

  RETURN v_label;
END;
$function$;

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
  -- 2026-09-24: the bars are the wallet's LARGEST collection's series, named
  -- the way every other page names them (series_display_label). Mixing every
  -- collection's raw series number into one row named nothing ("S0", "S9").
  series_coll AS (
    SELECT w.collection_id, c.slug, c.name
    FROM w JOIN collections c ON c.id = w.collection_id
    GROUP BY w.collection_id, c.slug, c.name
    ORDER BY count(*) DESC, c.slug
    LIMIT 1
  ),
  series_rows AS (
    -- 2026-09-25: grouped by LABEL — on-chain 0 and a stored 1 are both Top Shot
    -- "Series 1" and drew two bars.
    SELECT min(w.series_number) AS series_number,
           COALESCE(public.series_display_label(w.collection_id, w.series_number::int), 'SUnknown') AS label,
           count(*)::int AS cnt
    FROM w
    WHERE w.collection_id = (SELECT collection_id FROM series_coll)
    GROUP BY w.collection_id, COALESCE(public.series_display_label(w.collection_id, w.series_number::int), 'SUnknown')
  ),
  series AS (
    SELECT jsonb_object_agg(label, cnt) AS obj FROM series_rows
  ),
  series_bars AS (
    SELECT jsonb_agg(jsonb_build_object('label', label, 'count', cnt, 'series_number', series_number)
                     ORDER BY series_number NULLS LAST) AS arr
    FROM series_rows
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
               -- 2026-09-06: same basis as the headline (total − stale). The card
               -- printed NBA Top Shot $87,785 raw beside a $50,223 headline.
               'stale_fmv', round(COALESCE(sum(w.fmv_usd) FILTER (WHERE l.confidence = 'STALE'), 0)::numeric, 2),
               'stale_count', count(*) FILTER (WHERE l.confidence = 'STALE'),
               'market_closed_at', c.market_closed_at
             ) AS pc
      FROM w JOIN collections c ON c.id = w.collection_id
      LEFT JOIN LATERAL (
        SELECT l.confidence FROM editions e JOIN edition_fmv_current l ON l.edition_id = e.id
         WHERE e.external_id = w.edition_key AND e.collection_id = w.collection_id LIMIT 1
      ) l ON true
      GROUP BY c.slug, c.name, c.market_closed_at
    ) x
  ),
  -- 2026-09-04: stale split, so the front door can headline total − stale like the profile
  stale AS (
    SELECT
      round(COALESCE(sum(w.fmv_usd) FILTER (
        WHERE w.collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      ), 0)::numeric, 2) AS stale_fmv,
      -- 2026-09-25: the COUNT pairs with the AMOUNT — a closed market's STALE
      -- holdings are outside both, or the card says "$6,419 across 227" when
      -- 191 of the 227 are UFC moments whose dollars the figure excludes.
      count(*) FILTER (
        WHERE w.collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      )::int AS stale_count
    FROM w
    JOIN editions e ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
    JOIN edition_fmv_current l ON l.edition_id = e.id
    WHERE l.confidence = 'STALE'
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
    'seriesBars', COALESCE((SELECT arr FROM series_bars), '[]'::jsonb),
    'seriesCollection', (SELECT jsonb_build_object('slug', slug, 'name', name) FROM series_coll),
    'perCollection', COALESCE((SELECT arr FROM per_coll), '[]'::jsonb),
    'rarest', (SELECT obj FROM rarest),
    'staleFmv', COALESCE((SELECT stale_fmv FROM stale), 0),
    'staleCount', COALESCE((SELECT stale_count FROM stale), 0)
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

-- Current FMV confidence per holding: Ant (k2, $50) is STALE; Dame (k1) HIGH; k3/k4 unknown.
INSERT INTO public.editions (id, external_id, collection_id) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'k1', :TS::uuid),
  ('00000000-0000-0000-0000-0000000000e2', 'k2', :TS::uuid),
  ('00000000-0000-0000-0000-0000000000e4', 'k4', :TS::uuid);
INSERT INTO public.edition_fmv_current (edition_id, confidence) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'HIGH'),
  ('00000000-0000-0000-0000-0000000000e2', 'STALE');

-- ── 1. totals ────────────────────────────────────────────────────────────────
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'totalMoments'), '4', 'totalMoments = 4');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'totalFmv'), '150.00', 'totalFmv = 150.00 (nulls ignored)');

-- ── 2. topMoments: only fmv>0, desc ──────────────────────────────────────────
SELECT _assert_eq(jsonb_array_length(public.get_wallet_collection_snapshot('W') -> 'topMoments')::text, '2', 'topMoments has 2 (fmv>0 only)');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') -> 'topMoments' -> 0 ->> 'playerName'), 'Dame', 'top moment is highest FMV (Dame)');

-- ── 3. badgeCount = distinct matched edition_keys ────────────────────────────
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'badgeCount'), '2', 'badgeCount = 2 (k1,k3)');

-- ── 4. series bars: the largest collection only, named, one bar per label ─────
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') -> 'seriesBreakdown' ->> 'Series 4'), '3', 'Top Shot (largest) series 4 = 3, named "Series 4"');
SELECT _assert((public.get_wallet_collection_snapshot('W') -> 'seriesBreakdown' ->> 'SUnknown') IS NULL, 'the Pinnacle moment''s NULL series does not leak into the Top Shot bars');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') -> 'seriesCollection' ->> 'slug'), 'nba_top_shot', 'bars are named for the largest collection');
SELECT _assert_eq(jsonb_array_length(public.get_wallet_collection_snapshot('W') -> 'seriesBars')::text, '1', 'one bar');
-- on-chain 0 and stored 1 are both Top Shot "Series 1": ONE bar, not two.
INSERT INTO public.collection_series (id, collection_id, series_number, display_label, season) VALUES
  (1, :TS::uuid, 0, '1', '2019-20'), (2, :TS::uuid, 1, '1', '2019-20');
INSERT INTO public.wallet_moments_cache (wallet_address, player_name, set_name, tier, serial_number, edition_key, image_url, series_number, fmv_usd, mint_count, collection_id) VALUES
  ('W2','A','Base','COMMON',1,'z1','i',0,1,10,:TS::uuid), ('W2','B','Base','COMMON',2,'z2','i',1,1,10,:TS::uuid);
SELECT _assert_eq(jsonb_array_length(public.get_wallet_collection_snapshot('W2') -> 'seriesBars')::text, '1', 'series 0 and 1 share the label Series 1 -> one bar');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W2') -> 'seriesBars' -> 0 ->> 'count'), '2', 'the merged bar counts both moments');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W2') -> 'seriesBars' -> 0 ->> 'label'), 'Series 1', 'labelled Series 1');

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

-- ── 7b. stale split (2026-09-04/06): the headline can be rendered as total − stale,
--      and each perCollection entry carries the SAME basis so the share card's
--      per-collection figure cannot exceed the headline (NBA Top Shot printed
--      $87,785 raw beside a $50,223 headline before 20260906174634).
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'staleFmv'), '50.00', 'staleFmv = Ant''s 50 (the one STALE holding)');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'staleCount'), '1', 'staleCount = 1');
SELECT _assert_eq((SELECT pc ->> 'stale_fmv' FROM jsonb_array_elements(public.get_wallet_collection_snapshot('W') -> 'perCollection') pc WHERE pc ->> 'slug' = 'nba_top_shot'), '50.00', 'perCollection Top Shot stale_fmv = 50.00');
SELECT _assert_eq((SELECT pc ->> 'stale_count' FROM jsonb_array_elements(public.get_wallet_collection_snapshot('W') -> 'perCollection') pc WHERE pc ->> 'slug' = 'nba_top_shot'), '1', 'perCollection Top Shot stale_count = 1');
SELECT _assert_eq((SELECT pc ->> 'stale_fmv' FROM jsonb_array_elements(public.get_wallet_collection_snapshot('W') -> 'perCollection') pc WHERE pc ->> 'slug' = 'disney_pinnacle'), '0.00', 'a collection with no STALE holding reports 0.00, not null');
SELECT _assert_eq((public.get_wallet_collection_snapshot('none') ->> 'staleFmv'), '0.00', 'empty wallet -> staleFmv 0.00');

-- ── 8. closed-market exclusion (2026-08-03): a closed collection's moments still
--      COUNT (real holdings) but its dead-market value is excluded from totalFmv,
--      and perCollection carries market_closed_at so the UI renders a count+note.
UPDATE public.collections SET market_closed_at = now() WHERE slug = 'nba_top_shot';
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'totalMoments'), '4', 'closed market still counts moments (totalMoments stays 4)');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'totalFmv'), '0.00', 'closed Top Shot FMV excluded from totalFmv (only Pinnacle $0 remains)');
SELECT _assert((SELECT (pc ->> 'market_closed_at') IS NOT NULL FROM jsonb_array_elements(public.get_wallet_collection_snapshot('W') -> 'perCollection') pc WHERE pc ->> 'slug' = 'nba_top_shot'), 'perCollection Top Shot carries market_closed_at');
-- 2026-09-25: the stale footnote's COUNT pairs with its AMOUNT — Ant's STALE
-- $50 sits in the now-closed Top Shot market, so BOTH leave the headline pair
-- (the card had read "$6,419 across 227" with 191 of the 227 in closed UFC).
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'staleFmv'), '0.00', 'closed-market STALE dollars leave staleFmv');
SELECT _assert_eq((public.get_wallet_collection_snapshot('W') ->> 'staleCount'), '0', 'closed-market STALE holdings leave staleCount too (count pairs with amount)');

SELECT '✓ get_wallet_collection_snapshot: all assertions passed' AS result;

ROLLBACK;
