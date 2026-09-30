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
--   * slots ordered ASC; a user with no slabs -> '[]' (never NULL);
--   * ⭐ ART IS THE ONE FIELD WHERE THE SNAPSHOT WINS — asserted in BOTH
--     directions: a stored thumbnail is kept even when the edition has its own,
--     and a NULL stored thumbnail falls back to the edition's render. The
--     fallback half is new on 2026-09-12; until then there was no live side at
--     all and a junk stored URL rendered as a blank slab with no recourse.
--   * jersey_number (2026-09-29) is the live edition's number, NULL when the
--     edition does not resolve AND NULL when it is 0 (0 = no number on file,
--     never jersey #0 — specialCats() would otherwise need to know).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260930060000_audit_20260929_trophy_slab_exposes_jersey_number_for_special_serial_marks.sql);
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
  moment_id text, collection_id uuid, edition_key text, wallet_address text);
-- held_state fixtures (2026-09-28)
CREATE TABLE public.saved_wallets (user_id uuid, wallet_addr text);
CREATE TABLE public.wmc_clean_walks (wallet_address text, collection_id uuid, last_clean_walk_at timestamptz, observed_count int);
CREATE TABLE public.saved_collector_identities (user_id uuid, collection_id uuid, identity_kind text, identity_value text);
CREATE TABLE public.panini_collector_walks (username text, last_complete_at timestamptz, profile_state text);
CREATE TABLE public.panini_user_holdings (username text, url_key text);
CREATE TABLE public.panini_card_serials (sku text, owner text, serial_state text, captured_at timestamptz);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, fmv_usd numeric, confidence text, computed_at timestamptz);
CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text, name text);
CREATE TABLE public.moment_acquisitions (
  nft_id text, buy_price numeric, acquisition_method text, acquired_date timestamptz,
  collection_id uuid);

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
      -- ⭐ THE ONE DISPLAY FIELD WITH NO LIVE SIDE, until 2026-09-12. Every
      -- neighbour here is COALESCE(e.<live>, tm.<snapshot>); art alone was the
      -- frozen pin-time value, so a trophy whose stored URL was junk had
      -- nothing to fall back to and published as a blank slab. One live row
      -- (1 of 22) carries a truncated static render that 404s, and it belongs
      -- to one of the 4 of 7 collectors who have pinned exactly one Moment.
      --
      -- ⚠ THE SNAPSHOT WINS HERE AND LOSES EVERYWHERE ELSE, deliberately, and
      -- the asymmetry is measured rather than stylistic: 7 of the 8 rows where
      -- the two disagree store assets.nbatopshot.com/media/<nft>/image?width=
      -- 180|512 — a per-serial derivative of ~31KB — against an `editions`
      -- master that is a 2880x2880 PNG of 4-7MB. Live-first would swap eight
      -- working thumbnails for eight masters, several of them over the OG
      -- card's own byte cap. So this is a FALLBACK, not a preference: it fires
      -- only where the stored art is absent, which is exactly what
      -- sanitizeTrophyThumbnail() produces when it rejects a URL.
      COALESCE(tm.thumbnail_url, e.thumbnail_url) AS thumbnail_url,
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
      -- Special-serial jersey match (lib/badges/glyphs.ts specialCats). NULL
      -- unless > 0: 0 means no number on file, never jersey #0.
      (CASE WHEN e.jersey_number > 0 THEN e.jersey_number END) AS jersey_number,
      tm.pinned_at,
      -- Is the trophy still in the collector's indexed holdings? THREE states
      -- (2026-09-28): 'held' / 'not_held' / 'unknown'. 'not_held' needs a CLEAN
      -- walk after the pin for every relevant wallet or linked username; without
      -- one the answer is 'unknown', never a guess.
      hs.held_state,
      hs.held_checked_at,
      (
        SELECT ma.buy_price FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
          AND ma.collection_id = tm.collection_id
        ORDER BY ma.acquired_date DESC NULLS LAST
        LIMIT 1
      ) AS acquired_price,
      (
        SELECT ma.acquisition_method FROM moment_acquisitions ma
        WHERE ma.nft_id = tm.moment_id
          AND ma.collection_id = tm.collection_id
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
    LEFT JOIN LATERAL (
      WITH uw AS (
        SELECT DISTINCT sw.wallet_addr FROM saved_wallets sw WHERE sw.user_id = tm.user_id
      ),
      -- FLOW / SOLANA: the moment under any of the user's saved wallets.
      w_present AS (
        SELECT EXISTS (
          SELECT 1 FROM wallet_moments_cache w
          JOIN uw ON uw.wallet_addr = w.wallet_address
          WHERE w.moment_id = tm.moment_id AND w.collection_id = tm.collection_id
        ) AS present
      ),
      -- The wallets that hold anything in this collection (or were cleanly
      -- walked for it). Each must have a clean walk AFTER the pin, and a recent
      -- one: prune_stale_wmc drops rows unseen for 14 days, and a clean walk
      -- refreshes every held row, so a floor older than 13 days could be
      -- looking at a pruned-but-held moment.
      w_relevant AS (
        SELECT uw.wallet_addr, cw.last_clean_walk_at
        FROM uw
        LEFT JOIN wmc_clean_walks cw
          ON cw.wallet_address = uw.wallet_addr AND cw.collection_id = tm.collection_id
        WHERE cw.wallet_address IS NOT NULL
           OR EXISTS (SELECT 1 FROM wallet_moments_cache w2
                      WHERE w2.wallet_address = uw.wallet_addr AND w2.collection_id = tm.collection_id)
      ),
      -- PANINI: cards under the usernames the user linked.
      p_names AS (
        SELECT sci.identity_value AS username, pw.last_complete_at, pw.profile_state
        FROM saved_collector_identities sci
        LEFT JOIN panini_collector_walks pw ON pw.username = sci.identity_value
        WHERE sci.user_id = tm.user_id AND sci.collection_id = tm.collection_id
          AND sci.identity_kind = 'username'
      ),
      p_present AS (
        SELECT EXISTS (
          SELECT 1 FROM panini_user_holdings h JOIN p_names n ON n.username = h.username
          WHERE h.url_key = tm.moment_id
        ) OR EXISTS (
          SELECT 1 FROM panini_card_serials s JOIN p_names n ON s.owner <> '' AND lower(s.owner) = n.username
          WHERE s.sku = tm.moment_id AND COALESCE(s.serial_state, '') <> 'BURNT'
            AND (n.last_complete_at IS NULL OR s.captured_at > n.last_complete_at)
        ) AS present
      )
      SELECT
        CASE
          WHEN c.slug = 'panini_blockchain' THEN
            CASE
              WHEN (SELECT present FROM p_present) THEN 'held'
              WHEN EXISTS (SELECT 1 FROM p_names)
               AND NOT EXISTS (SELECT 1 FROM p_names n
                               WHERE n.last_complete_at IS NULL OR n.last_complete_at <= tm.pinned_at
                                  OR n.profile_state IS DISTINCT FROM 'public')
              THEN 'not_held'
              ELSE 'unknown'
            END
          ELSE
            CASE
              WHEN (SELECT present FROM w_present) THEN 'held'
              WHEN EXISTS (SELECT 1 FROM w_relevant)
               AND NOT EXISTS (SELECT 1 FROM w_relevant r
                               WHERE r.last_clean_walk_at IS NULL
                                  OR r.last_clean_walk_at <= tm.pinned_at
                                  OR r.last_clean_walk_at < now() - interval '13 days')
              THEN 'not_held'
              ELSE 'unknown'
            END
        END AS held_state,
        CASE
          WHEN c.slug = 'panini_blockchain' THEN (SELECT min(n.last_complete_at) FROM p_names n)
          ELSE (SELECT min(r.last_clean_walk_at) FROM w_relevant r)
        END AS held_checked_at
    ) hs ON true
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
  ('bbbbbbbb-0000-0000-0000-00000000000b'::uuid, 1, 'mB', 'k2', 'Denorm2', 'DenSet', 3,  50, 'RARE',   'thumbB', 'denvid', 22, ARRAY['frozenY'], 'noteB', :TS::uuid, :U1::uuid, now()),
  -- Slot 3: mE resolves to e1 (via tm.edition_id — no wmc row, deliberately) and
  -- stores NO art: the shape sanitizeTrophyThumbnail() produces when it rejects a
  -- URL, and the shape that used to render ART UNAVAILABLE forever.
  -- ⚠ NAMED mE, NOT mC. `mC` is already taken by the impossible-pair fixtures
  -- below — same moment_id, same uuid, and a wmc row pointing it at k3 — so the
  -- obvious next letter silently re-pointed this slab at a different edition and
  -- the assertion failed against `edthumb3`. Two fixture blocks, one namespace.
  ('eeeeeeee-0000-0000-0000-00000000000e'::uuid, 3, 'mE', 'k1', 'Denorm3', 'DenSet3', 7, 70, 'COMMON', NULL,     'evid',   33, ARRAY['frozenZ'], 'noteE', :TS::uuid, :U1::uuid, now());

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
INSERT INTO public.moment_acquisitions (nft_id, buy_price, acquisition_method, acquired_date, collection_id) VALUES
  ('mA', 20, 'pack',        now() - interval '10 days', :TS::uuid),
  ('mA', 30, 'marketplace', now() - interval '1 day',   :TS::uuid),
  -- ⛔ SAME nft_id, ANOTHER collection, and the NEWEST row (2026-09-27): a
  -- moment_id is unique only within a collection. An unscoped read took this.
  ('mA', 999, 'gift',       now(),                      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid);

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
SELECT _assert_eq(jsonb_array_length(public.get_trophy_slab_data(:U1::uuid))::text, '3', 'three slabs returned');
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
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'acquired_price'), '30', 'mA acquired_price = latest IN ITS OWN COLLECTION (30), not the newer 999 from another collection');
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'acquisition_method'), 'marketplace', 'mA method = latest');

-- ── 7. ART: the snapshot wins, and a MISSING snapshot falls back to the edition ─
-- ⭐ BOTH DIRECTIONS, because each one alone is satisfied by a wrong function.
-- `tm.thumbnail_url` alone (the pre-2026-09-12 definition) passes the first and
-- fails the second; `COALESCE(e.thumbnail_url, tm.thumbnail_url)` — the obvious
-- "make it consistent with every neighbour" edit — passes the second and fails
-- the first, which in production would swap 8 small per-serial derivatives for
-- 2880x2880 masters, several over the OG card's own byte cap.
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'thumbnail_url'), 'thumbA', 'mA keeps its STORED art even though the edition has its own');
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 2 ->> 'thumbnail_url'), 'edthumb1', 'mE (no stored art) falls back to the edition render');
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 0 ->> 'thumbnail_url'), 'thumbB', 'mB (no edition at all) keeps its stored art');

-- ── 8. empty user -> '[]' ────────────────────────────────────────────────────
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

-- ── 9. held_state: held / not_held / unknown (2026-09-28) ─────────────────────
-- 'not_held' is a claim that a trophy LEFT the collector's wallets, so it needs a
-- clean walk after the pin (and a recent one); every other shape is 'unknown'.
\set U4 '''40000000-0000-0000-0000-000000000004'''
\set U5 '''50000000-0000-0000-0000-000000000005'''
\set U7 '''70000000-0000-0000-0000-000000000007'''
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set GZ '''06248cc4-b85f-47cd-af67-1855d14acd75'''
\set CM '''209ade70-32c5-4470-bc7c-4793d660f713'''
\set UF '''9b4824a8-736d-4a96-b450-8dcc0c46b023'''
\set PN '''d1a0a7f5-609a-49f4-a1a7-4eaac55b020b'''
INSERT INTO public.collections (id, slug, name) VALUES
  (:AD::uuid, 'nfl_all_day', 'All Day'), (:GZ::uuid, 'laliga_golazos', 'Golazos'),
  (:CM::uuid, 'candy_mlb', 'Candy'), (:UF::uuid, 'ufc_strike', 'UFC'), (:PN::uuid, 'panini_blockchain', 'Panini');
INSERT INTO public.saved_wallets VALUES (:U4::uuid, 'w4');
INSERT INTO public.wallet_moments_cache (moment_id, collection_id, edition_key, wallet_address) VALUES
  ('h1', :TS::uuid, NULL, 'w4'),        -- h1 still cached -> held
  ('other', :TS::uuid, NULL, 'w4'),     -- w4 is relevant to Top Shot
  ('x', :AD::uuid, NULL, 'w4'), ('g', :GZ::uuid, NULL, 'w4'), ('y', :CM::uuid, NULL, 'w4');
INSERT INTO public.wmc_clean_walks VALUES
  ('w4', :TS::uuid, now() - interval '1 hour', 1),   -- after the pin, recent
  ('w4', :AD::uuid, now() - interval '5 days', 1),   -- BEFORE h3's pin
  ('w4', :GZ::uuid, now() - interval '20 days', 1);  -- after h4's pin but too old (prune window)
-- Candy (CM): no clean walk ever (its refresh is add-only). UFC: no wallet holds anything.
INSERT INTO public.trophy_moments (id, slot, moment_id, collection_id, user_id, pinned_at) VALUES
  (gen_random_uuid(), 1, 'h1', :TS::uuid, :U4::uuid, now() - interval '2 days'),
  (gen_random_uuid(), 2, 'h2', :TS::uuid, :U4::uuid, now() - interval '2 days'),
  (gen_random_uuid(), 3, 'h3', :AD::uuid, :U4::uuid, now() - interval '1 day'),
  (gen_random_uuid(), 4, 'h4', :GZ::uuid, :U4::uuid, now() - interval '30 days'),
  (gen_random_uuid(), 5, 'h5', :CM::uuid, :U4::uuid, now() - interval '2 days'),
  (gen_random_uuid(), 6, 'h6', :UF::uuid, :U4::uuid, now() - interval '2 days');
SELECT _assert_eq((public.get_trophy_slab_data(:U4::uuid) -> 0 ->> 'held_state'), 'held', 'h1 still under a saved wallet -> held');
SELECT _assert_eq((public.get_trophy_slab_data(:U4::uuid) -> 1 ->> 'held_state'), 'not_held', 'h2 absent after a clean walk that post-dates the pin -> not_held');
SELECT _assert((public.get_trophy_slab_data(:U4::uuid) -> 1 ->> 'held_checked_at') IS NOT NULL, 'not_held carries the clean-walk time it rests on');
SELECT _assert_eq((public.get_trophy_slab_data(:U4::uuid) -> 2 ->> 'held_state'), 'unknown', 'h3: the only clean walk is OLDER than the pin -> unknown, not sold');
SELECT _assert_eq((public.get_trophy_slab_data(:U4::uuid) -> 3 ->> 'held_state'), 'unknown', 'h4: clean walk older than 13 days (prune window) -> unknown');
SELECT _assert_eq((public.get_trophy_slab_data(:U4::uuid) -> 4 ->> 'held_state'), 'unknown', 'h5: a collection with no clean-walk stamp (Candy) -> unknown');
SELECT _assert_eq((public.get_trophy_slab_data(:U4::uuid) -> 5 ->> 'held_state'), 'unknown', 'h6: no wallet relevant to the collection -> unknown');

-- Panini: U5 links 'pn' (complete public walk 1h ago), U7 links 'priv' (private profile).
INSERT INTO public.saved_collector_identities VALUES
  (:U5::uuid, :PN::uuid, 'username', 'pn'), (:U7::uuid, :PN::uuid, 'username', 'priv');
INSERT INTO public.panini_collector_walks VALUES ('pn', now() - interval '1 hour', 'public'), ('priv', now() - interval '1 hour', 'private');
INSERT INTO public.panini_user_holdings VALUES ('pn', 'p1');
INSERT INTO public.panini_card_serials VALUES
  ('p3', 'PN', 'AVAILABLE', now()),                       -- seen under the name AFTER the walk -> held
  ('p2', 'pn', 'AVAILABLE', now() - interval '3 hours');  -- seen BEFORE the walk, absent from it -> gone
INSERT INTO public.trophy_moments (id, slot, moment_id, collection_id, user_id, pinned_at) VALUES
  (gen_random_uuid(), 1, 'p1', :PN::uuid, :U5::uuid, now() - interval '1 day'),
  (gen_random_uuid(), 2, 'p2', :PN::uuid, :U5::uuid, now() - interval '1 day'),
  (gen_random_uuid(), 3, 'p3', :PN::uuid, :U5::uuid, now() - interval '1 day'),
  (gen_random_uuid(), 1, 'p4', :PN::uuid, :U7::uuid, now() - interval '1 day');
SELECT _assert_eq((public.get_trophy_slab_data(:U5::uuid) -> 0 ->> 'held_state'), 'held', 'Panini p1 on the walked profile -> held');
SELECT _assert_eq((public.get_trophy_slab_data(:U5::uuid) -> 1 ->> 'held_state'), 'not_held', 'Panini p2 absent after a complete public walk post-pin -> not_held');
SELECT _assert_eq((public.get_trophy_slab_data(:U5::uuid) -> 2 ->> 'held_state'), 'held', 'Panini p3 seen under the name after the walk -> held');
SELECT _assert_eq((public.get_trophy_slab_data(:U7::uuid) -> 0 ->> 'held_state'), 'unknown', 'a private Panini profile -> unknown, never sold');

-- ── 10. jersey_number for the special-serial marks (2026-09-29) ──────────────
-- ⚠ Both directions plus the 0 case: a live number comes through, an unresolved
-- edition gives NULL, and 0 (no number on file) is NEVER published as a number.
SELECT _assert_eq((public.get_trophy_slab_data(:U1::uuid) -> 1 ->> 'jersey_number'), '5', 'mA: jersey_number from the live edition');
SELECT _assert((public.get_trophy_slab_data(:U1::uuid) -> 0 ->> 'jersey_number') IS NULL, 'mB (no edition): jersey_number NULL, not guessed');
SELECT _assert((public.get_trophy_slab_data(:U1::uuid) -> 0) ? 'jersey_number', 'the key is present even when NULL');
UPDATE public.editions SET jersey_number = 0 WHERE id = 'e3333333-3333-3333-3333-333333333333'::uuid;
SELECT _assert((public.get_trophy_slab_data(:U3::uuid) -> 0 ->> 'jersey_number') IS NULL, 'mC: jersey 0 (no number on file) is NULL, never "0"');

SELECT '✓ get_trophy_slab_data: all assertions passed' AS result;

ROLLBACK;
