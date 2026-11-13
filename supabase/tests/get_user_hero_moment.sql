-- DB invariant: public.get_user_hero_moment(uuid) — the dashboard / profile hero card.
-- Pinned 2026-11-13 when the auto-pick path moved to a two-step read (top holding from the covering index,
-- then one keyed fetch). What must hold whatever the plan:
--   1. AUTO picks the user's highest-fmv holding across ALL their saved wallets, with its own row's columns
--      (the second step must fetch THAT row, not another of the same edition at a different fmv);
--   2. a holding in someone else's wallet never wins, however expensive;
--   3. a MANUAL override that the user actually holds wins over a higher-fmv holding;
--   4. an override the user does NOT hold falls back to the auto pick (never an empty hero);
--   5. a user with no priced holding gets no row (not a fabricated zero-value hero).
-- The function DDL is VERBATIM from
-- supabase/migrations/20261113191137_audit_20261113_hero_moment_auto_pick_reads_the_covering_index.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.saved_wallets (user_id uuid, wallet_addr text);
CREATE TABLE public.profile_bio (user_id uuid, hero_moment_id text, hero_moment_collection_id uuid);
CREATE TABLE public.wallet_moments_cache (
  id serial PRIMARY KEY, wallet_address text, moment_id text, edition_key text, fmv_usd numeric,
  serial_number integer, player_name text, set_name text, tier text, series_number integer,
  collection_id uuid, is_locked boolean, mint_count integer, image_url text, fmv_confidence text
);

-- >>> BEGIN verbatim get_user_hero_moment >>>
CREATE OR REPLACE FUNCTION public.get_user_hero_moment(p_user_id uuid)
 RETURNS TABLE(moment_id text, collection_id uuid, collection_slug text, wallet_address text, player_name text, set_name text, tier text, serial_number integer, mint_count integer, fmv_usd numeric, image_url text, is_locked boolean, series_number integer, edition_key text, is_manual_override boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '5s'
AS $function$
  WITH override AS (
    SELECT pb.hero_moment_id, pb.hero_moment_collection_id
    FROM profile_bio pb
    WHERE pb.user_id = p_user_id
      AND pb.hero_moment_id IS NOT NULL
    LIMIT 1
  ),
  user_wallets AS (
    SELECT DISTINCT wallet_addr
    FROM saved_wallets
    WHERE user_id = p_user_id
  ),
  -- Manual override path: look up the specific moment if it's actually in the user's cache
  manual AS (
    SELECT
      wmc.moment_id,
      wmc.collection_id,
      wmc.wallet_address,
      wmc.player_name, wmc.set_name, wmc.tier,
      wmc.serial_number, wmc.mint_count, wmc.fmv_usd, wmc.image_url,
      wmc.is_locked, wmc.series_number, wmc.edition_key,
      TRUE AS is_manual_override
    FROM wallet_moments_cache wmc
    JOIN user_wallets uw ON uw.wallet_addr = wmc.wallet_address
    JOIN override o
      ON wmc.moment_id = o.hero_moment_id
     AND (o.hero_moment_collection_id IS NULL OR wmc.collection_id = o.hero_moment_collection_id)
    LIMIT 1
  ),
  -- Auto-pick path: highest fmv_usd. audit_20261113: step 1 reads only columns the covering index
  -- idx_wmc_wallet_coll_ek_fmv_tier carries (index-only scan, no heap fetch per holding); step 2 fetches the
  -- one chosen row by its keys. Reading every holding's heap row was 28.7k cold disk reads for a 47k-row user.
  top AS (
    SELECT wmc.wallet_address, wmc.collection_id, wmc.edition_key, wmc.fmv_usd
    FROM wallet_moments_cache wmc
    JOIN user_wallets uw ON uw.wallet_addr = wmc.wallet_address
    WHERE wmc.fmv_usd > 0
      AND wmc.edition_key IS NOT NULL
    ORDER BY wmc.fmv_usd DESC
    LIMIT 1
  ),
  auto AS (
    SELECT
      w.moment_id,
      w.collection_id,
      w.wallet_address,
      w.player_name, w.set_name, w.tier,
      w.serial_number, w.mint_count, w.fmv_usd, w.image_url,
      w.is_locked, w.series_number, w.edition_key,
      FALSE AS is_manual_override
    FROM top t
    CROSS JOIN LATERAL (
      SELECT wmc.*
      FROM wallet_moments_cache wmc
      WHERE wmc.wallet_address = t.wallet_address
        AND wmc.collection_id = t.collection_id
        AND wmc.edition_key = t.edition_key
        AND wmc.fmv_usd = t.fmv_usd
      LIMIT 1
    ) w
  ),
  chosen AS (
    SELECT * FROM manual
    UNION ALL
    SELECT * FROM auto WHERE NOT EXISTS (SELECT 1 FROM manual)
  )
  SELECT
    ch.moment_id,
    ch.collection_id,
    c.slug::TEXT AS collection_slug,
    ch.wallet_address,
    ch.player_name, ch.set_name, ch.tier,
    ch.serial_number, ch.mint_count, ch.fmv_usd, ch.image_url,
    ch.is_locked, ch.series_number, ch.edition_key,
    ch.is_manual_override
  FROM chosen ch
  LEFT JOIN collections c ON c.id = ch.collection_id;
$function$;
-- <<< END verbatim get_user_hero_moment <<<

INSERT INTO public.collections VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day');

-- user A holds two wallets; user B holds one.
INSERT INTO public.saved_wallets VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '0xa1'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '0xa2'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '0xb1'),
  ('cccccccc-0000-0000-0000-000000000003', '0xc1');

INSERT INTO public.wallet_moments_cache
  (wallet_address, moment_id, edition_key, fmv_usd, serial_number, player_name, collection_id) VALUES
  ('0xa1', 'm-a1-low',  '1:1', 10,   5,  'Low A',  '95f28a17-224a-4025-96ad-adf8a4c63bfd'),
  -- same wallet + edition as the winner at a lower fmv, inserted first: step 2 must not fetch it
  ('0xa2', 'm-a2-same', '9:9', 40,   77, 'Same Ed', 'dee28451-5d62-409e-a1ad-a83f763ac070'),
  ('0xa2', 'm-a2-top',  '9:9', 250,  3,  'Top A',  'dee28451-5d62-409e-a1ad-a83f763ac070'),
  ('0xa2', 'm-a2-null', NULL,  NULL, 1,  'No FMV', '95f28a17-224a-4025-96ad-adf8a4c63bfd'),
  ('0xb1', 'm-b1-rich', '7:7', 9999, 1,  'Rich B', '95f28a17-224a-4025-96ad-adf8a4c63bfd'),
  ('0xc1', 'm-c1-zero', '2:2', 0,    1,  'Zero C', '95f28a17-224a-4025-96ad-adf8a4c63bfd');

DO $$
DECLARE r record;
BEGIN
  -- (1) + (2)
  SELECT * INTO r FROM public.get_user_hero_moment('aaaaaaaa-0000-0000-0000-000000000001');
  PERFORM _assert_eq(r.moment_id, 'm-a2-top', 'auto picks the highest-fmv holding across all saved wallets');
  PERFORM _assert_eq(r.fmv_usd::text, '250', 'with its own fmv');
  PERFORM _assert_eq(r.serial_number::text, '3', 'and its own row (not another holding of the same edition)');
  PERFORM _assert_eq(r.collection_slug, 'nfl_all_day', 'and its collection slug');
  PERFORM _assert_eq(r.is_manual_override::text, 'false', 'flagged as the auto pick');

  -- (5) no priced holding -> no row
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.get_user_hero_moment('cccccccc-0000-0000-0000-000000000003')),
    'a user with no priced holding gets no hero row');

  -- (3) a held override wins over a higher-fmv holding
  INSERT INTO public.profile_bio VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'm-a1-low', NULL);
  SELECT * INTO r FROM public.get_user_hero_moment('aaaaaaaa-0000-0000-0000-000000000001');
  PERFORM _assert_eq(r.moment_id, 'm-a1-low', 'a held manual override wins');
  PERFORM _assert_eq(r.is_manual_override::text, 'true', 'and says so');

  -- (4) an override the user does not hold falls back to auto
  UPDATE public.profile_bio SET hero_moment_id = 'm-b1-rich' WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  SELECT * INTO r FROM public.get_user_hero_moment('aaaaaaaa-0000-0000-0000-000000000001');
  PERFORM _assert_eq(r.moment_id, 'm-a2-top', 'an override held by someone else falls back to the auto pick');

  RAISE NOTICE '✓ get_user_hero_moment: auto pick, override, fallback, no-fabricated-hero';
END $$;

ROLLBACK;
