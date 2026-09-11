-- DB invariant: public.get_trophy_slab_data — the trophy-case read (the pinned
-- "slabs" on a profile). It denormalizes each pinned moment, but the LIVE editions
-- row must win over the frozen trophy_moments snapshot so a slab never shows a
-- stale player/set/tier/FMV, and the badges/acquisition data must resolve cleanly.
--
-- Pins:
--   * auth.uid() set and <> p_user_id raises 42501; anon passes;
--   * COALESCE precedence editions-over-denorm for player_name/set_name/tier/
--     video, and the latest fmv_snapshot over the frozen tm.fmv;
--   * ⭐ CIRCULATION IS NO LONGER A PLAIN COALESCE — a serial ABOVE the resolved
--     edition's circulation is impossible, so the reader falls back to the frozen
--     per-moment mint when that can hold the serial and to NULL when neither can.
--     THIS PIN WAS INVERTED 2026-09-11: it previously pinned the plain COALESCE,
--     i.e. it was holding the `#1017/50` defect in place. Inverted, never deleted.
--   * edition resolution via the wmc edition_key (falling back to tm.edition_id);
--   * badges come from get_edition_badges_unified when the edition resolves, else
--     the frozen tm.badges;
--   * acquired_price / acquisition_method take the LATEST moment_acquisitions row;
--   * slots ordered ASC; a user with no slabs -> '[]' (never NULL).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260911093000_audit_20260911_trophy_slab_refuses_an_impossible_serial_over_circulation.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('test.auth_uid', true), '')::uuid
$$;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.trophy_moments (
  id uuid, slot int, moment_id text, edition_id text, player_name text,
  set_name text, serial_number int, circulation_count int, tier text,
  thumbnail_url text, video_url text, fmv numeric, badges text[], note text,
  collection_id uuid, user_id uuid, pinned_at timestamptz);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, external_id text, player_name text,
  set_name text, tier text, circulation_count int, video_url text,
  jersey_number smallint, play_category text, team_name text, series smallint,
  thumbnail_url text);
CREATE TABLE public.wallet_moments_cache (
  moment_id text, collection_id uuid, edition_key text);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, fmv_usd numeric, confidence text, computed_at timestamptz);
CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text, name text);
CREATE TABLE public.moment_acquisitions (
  nft_id text, buy_price numeric, acquisition_method text, acquired_date timestamptz);

CREATE FUNCTION public.serial_fmv_estimate(p_cid uuid, p_serial int, p_circ int, p_tier text, p_fmv numeric, p_conf text, p_jersey int, p_edition_id uuid)
 RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object('est', p_fmv) $$;
CREATE FUNCTION public.get_edition_badges_unified(p_edition_id uuid)
 RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '[{"title":"RealBadge"}]'::jsonb $$;

-- >>> BEGIN verbatim get_trophy_slab_data (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_trophy_slab_data(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  WITH slabs AS (
    SELECT
      tm.id, tm.slot, tm.moment_id, tm.edition_id,
      COALESCE(e.player_name, tm.player_name) AS player_name,
      COALESCE(e.set_name,    tm.set_name)    AS set_name,
      tm.serial_number,
      CASE
        WHEN tm.serial_number IS NOT NULL
         AND e.circulation_count IS NOT NULL
         AND tm.serial_number > e.circulation_count
        THEN CASE
               WHEN tm.circulation_count IS NOT NULL
                AND tm.serial_number <= tm.circulation_count
               THEN tm.circulation_count
               ELSE NULL::int
             END
        ELSE COALESCE(e.circulation_count, tm.circulation_count)
      END AS circulation_count,
      COALESCE(e.tier::text, tm.tier) AS tier,
      tm.thumbnail_url,
      COALESCE(e.video_url, tm.video_url) AS video_url,
      COALESCE(f.fmv_usd, tm.fmv) AS fmv,
      f.confidence AS fmv_confidence,
      -- Phase 2 serial-adjusted FMV (additive; owner surface renders it now).
      public.serial_fmv_estimate(
        tm.collection_id,
        tm.serial_number,
        CASE
          WHEN tm.serial_number IS NOT NULL
           AND e.circulation_count IS NOT NULL
           AND tm.serial_number > e.circulation_count
          THEN CASE
                 WHEN tm.circulation_count IS NOT NULL
                  AND tm.serial_number <= tm.circulation_count
                 THEN tm.circulation_count
                 ELSE NULL::int
               END
          ELSE COALESCE(e.circulation_count, tm.circulation_count)
        END,
        COALESCE(e.tier::text, tm.tier),
        COALESCE(f.fmv_usd, tm.fmv),
        f.confidence::text,
        (CASE WHEN e.jersey_number > 1 THEN e.jersey_number END),
        e.id
      ) AS serial_fmv,
      COALESCE(
        CASE WHEN e.id IS NOT NULL THEN (
          SELECT jsonb_agg(elem->>'title')
          FROM jsonb_array_elements(public.get_edition_badges_unified(e.id)) elem
          WHERE elem->>'title' IS NOT NULL
        ) END,
        to_jsonb(tm.badges)
      ) AS badges,
      tm.note,
      tm.collection_id,
      c.slug AS collection_slug,
      c.name AS collection_display_name,
      e.play_category AS play_description,
      e.team_name AS team_name,
      e.series AS series,
      tm.pinned_at,
      (
        SELECT ma.buy_price FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
        ORDER BY ma.acquired_date DESC NULLS LAST
        LIMIT 1
      ) AS acquired_price,
      (
        SELECT ma.acquisition_method FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
        ORDER BY ma.acquired_date DESC NULLS LAST
        LIMIT 1
      ) AS acquisition_method
    FROM trophy_moments tm
    LEFT JOIN LATERAL (
      SELECT w.edition_key
      FROM wallet_moments_cache w
      WHERE w.moment_id = tm.moment_id
        AND w.collection_id = tm.collection_id
        AND w.edition_key IS NOT NULL
      LIMIT 1
    ) wk ON true
    LEFT JOIN editions e
      ON e.external_id    = COALESCE(wk.edition_key, tm.edition_id)
     AND e.collection_id  = tm.collection_id
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) f ON true
    LEFT JOIN collections c ON c.id = tm.collection_id
    WHERE tm.user_id = p_user_id
    ORDER BY tm.slot ASC
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(slabs.*) ORDER BY slot), '[]'::jsonb)
  INTO v_result FROM slabs;

  RETURN v_result;
END;
$function$;
-- <<< END verbatim get_trophy_slab_data <<<

\set U1 '''10000000-0000-0000-0000-000000000001'''
\set U2 '''20000000-0000-0000-0000-000000000002'''
\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

INSERT INTO public.collections (id, slug, name) VALUES (:TS::uuid, 'nba_top_shot', 'NBA Top Shot');

-- slab in slot 2: mA resolves to a LIVE edition (e1) -> edition values must win.
-- slab in slot 1: mB has NO editions row -> the frozen denorm values are used.
INSERT INTO public.trophy_moments (id, slot, moment_id, edition_id, player_name, set_name, serial_number, circulation_count, tier, thumbnail_url, video_url, fmv, badges, note, collection_id, user_id, pinned_at) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a'::uuid, 2, 'mA', 'k1', 'OldName',  'OldSet', 5, 999, 'COMMON', 'thumbA', 'oldvid', 10, ARRAY['frozenX'], 'noteA', :TS::uuid, :U1::uuid, now()),
  ('bbbbbbbb-0000-0000-0000-00000000000b'::uuid, 1, 'mB', 'k2', 'Denorm2', 'DenSet', 3,  50, 'RARE',   'thumbB', 'denvid', 22, ARRAY['frozenY'], 'noteB', :TS::uuid, :U1::uuid, now());

INSERT INTO public.editions (id, collection_id, external_id, player_name, set_name, tier, circulation_count, video_url, jersey_number, play_category, team_name, series, thumbnail_url) VALUES
  ('e1111111-1111-1111-1111-111111111111'::uuid, :TS::uuid, 'k1', 'RealName', 'RealSet', 'RARE', 100, 'realvid', 5, 'Dunk', 'Blazers', 4, 'edthumb1');

-- ── 2026-09-11: the impossible-pair fixtures (the `#1017/50` shape) ──────────
-- mC: serial 1017 against a PARALLEL edition of 50, with a frozen per-moment mint
--     of 2034 that CAN hold it -> the frozen mint must win.
-- mD: serial 1017, parallel edition 50, and a frozen mint of 60 that ALSO cannot
--     hold it -> neither source is consistent, so the denominator must be NULL.
INSERT INTO public.trophy_moments (id, slot, moment_id, edition_id, player_name, set_name, serial_number, circulation_count, tier, thumbnail_url, video_url, fmv, badges, note, collection_id, user_id, pinned_at) VALUES
  ('cccccccc-0000-0000-0000-00000000000c'::uuid, 1, 'mC', 'k3', 'Wemby', 'PlayoffSet', 1017, 2034, 'COMMON', 'thumbC', NULL, 13, NULL, NULL, :TS::uuid, '30000000-0000-0000-0000-000000000003'::uuid, now()),
  ('dddddddd-0000-0000-0000-00000000000d'::uuid, 2, 'mD', 'k3', 'Wemby', 'PlayoffSet', 1017,   60, 'COMMON', 'thumbD', NULL, 13, NULL, NULL, :TS::uuid, '30000000-0000-0000-0000-000000000003'::uuid, now());

INSERT INTO public.editions (id, collection_id, external_id, player_name, set_name, tier, circulation_count, video_url, jersey_number, play_category, team_name, series, thumbnail_url) VALUES
  ('e3333333-3333-3333-3333-333333333333'::uuid, :TS::uuid, 'k3', 'Wemby', 'PlayoffSet', 'FANDOM', 50, NULL, NULL, NULL, 'Spurs', 8, 'edthumb3');

INSERT INTO public.wallet_moments_cache (moment_id, collection_id, edition_key) VALUES
  ('mC', :TS::uuid, 'k3'), ('mD', :TS::uuid, 'k3');
-- k2 has NO editions row on purpose.

-- wmc gives mA an edition_key so the editions join resolves.
INSERT INTO public.wallet_moments_cache (moment_id, collection_id, edition_key) VALUES ('mA', :TS::uuid, 'k1');

-- fresh snapshot 55 (over the frozen tm.fmv=10) for e1.
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at) VALUES
  ('e1111111-1111-1111-1111-111111111111'::uuid, 55, 'HIGH', now());

-- mA acquisitions: latest (30/marketplace) must win over the older (20/pack).
INSERT INTO public.moment_acquisitions (nft_id, buy_price, acquisition_method, acquired_date) VALUES
  ('mA', 20, 'pack',        now() - interval '10 days'),
  ('mA', 30, 'marketplace', now() - interval '1 day');

-- ── 1. cross-user guard ──────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM set_config('test.auth_uid', '20000000-0000-0000-0000-000000000002', true);
  BEGIN
    PERFORM public.get_trophy_slab_data('10000000-0000-0000-0000-000000000001'::uuid);
    RAISE EXCEPTION 'guard did not fire';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;
  PERFORM set_config('test.auth_uid', '', true);
END $$;

-- ── 2. two slabs, slot-ordered (slot 1 = mB first) ───────────────────────────
SELECT _assert_eq(jsonb_array_length(public.get_trophy_slab_data(:U1::uuid))::text, '2', 'two slabs returned');
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 0 ->> 'moment_id'), 'mB', 'slot ASC -> slot 1 (mB) first');

-- ── 3. mA: LIVE edition values win over the frozen denorm ─────────────────────
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'player_name'), 'RealName', 'mA player from editions (not frozen OldName)');
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'set_name'), 'RealSet', 'mA set from editions');
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'tier'), 'RARE', 'mA tier from editions (not frozen COMMON)');
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'circulation_count'), '100', 'mA circulation from editions');
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'fmv'), '55', 'mA fmv from latest snapshot (not frozen 10)');

-- ── 4. mA badges from the unified badge fn; mB (no edition) keeps frozen badges ─
SELECT _assert(public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'badges' ILIKE '%RealBadge%', 'mA badges from get_edition_badges_unified');
SELECT _assert(public.get_trophy_slab_data(:U1::uuid) -> 0 ->> 'badges' ILIKE '%frozenY%', 'mB (no edition) uses frozen badges');

-- ── 5. mB falls back to frozen denorm (no editions row) ──────────────────────
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 0 ->> 'player_name'), 'Denorm2', 'mB player from frozen denorm');
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 0 ->> 'fmv'), '22', 'mB fmv from frozen tm.fmv (no snapshot)');

-- ── 6. acquisition latest-wins ───────────────────────────────────────────────
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'acquired_price'), '30', 'mA acquired_price = latest (30)');
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'acquisition_method'), 'marketplace', 'mA method = latest');

-- ── 7. empty user -> '[]' ────────────────────────────────────────────────────
SELECT _assert_eq(public.get_trophy_slab_data(:U2::uuid)::text, '[]', 'no slabs -> empty array, not NULL');

\set U3 '''30000000-0000-0000-0000-000000000003'''

-- ── 8. an impossible serial/circulation pair is never published (2026-09-11) ──
-- ⚠ ASSERT THE ABSENCE OF THE FALSE CLAIM, not the presence of a message: the
-- defect was a rendered `#1017/50`, so the pin is that 50 never comes back.
SELECT _assert_eq((public.get_trophy_slab_data(:U3::uuid) -> 0 ->> 'circulation_count'), '2034',
  'mC: serial 1017 > parallel edition 50 -> frozen per-moment mint 2034 wins');
SELECT _assert((public.get_trophy_slab_data(:U3::uuid) -> 0 ->> 'circulation_count') <> '50',
  'mC: the parallel circulation 50 is NEVER published beside serial 1017');
SELECT _assert((public.get_trophy_slab_data(:U3::uuid) -> 1 ->> 'circulation_count') IS NULL,
  'mD: neither source can hold serial 1017 -> denominator dropped, not guessed');
-- ⚠ NON-VACUOUS CONTROL: the ordinary path must still take the edition value, or
-- a reader that returned NULL for everything would satisfy the two pins above.
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'circulation_count'), '100',
  'control: a POSSIBLE pair still takes the live edition circulation');

SELECT '✓ get_trophy_slab_data: all assertions passed' AS result;

ROLLBACK;
