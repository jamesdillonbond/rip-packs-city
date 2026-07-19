-- DB invariant: public.resolve_moment_id — the /moment/<id> + /edition dispatch
-- resolver. A single text id can be a Pinnacle render id, a moments/editions
-- UUID, or a numeric on-chain nft/flow id, and the resolver walks a STRICT
-- precedence ladder, returning the FIRST hit:
--   1. pinnacle_editions.id  (text match, any input)        → kind 'pinnacle_edition'
--   2. moments.id            (UUID input)                    → kind 'moment'
--   3. editions.id           (UUID input, else empty)        → kind 'edition'
--   4. moments.nft_id        (bigint input)                  → kind 'moment'
--   5. wallet_moments_cache  (bigint input, TS wins ties)    → kind 'moment'
--   6. cached_listings_v2    (bigint input, active > done)   → kind 'edition'
-- Two subtle invariants this pins: the wmc fallback PREFERS Top Shot on a
-- cross-collection nft-id collision, and the cached-listing fallback prefers an
-- OPEN listing (completed_at IS NULL) over a completed one. DDL below is a
-- VERBATIM copy of the committed migration
-- (supabase/migrations/20260704020000_audit_20260704_resolve_moment_id_cached_listings_fallback.sql),
-- which is byte-identical to live prod (verified via pg_get_functiondef).
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.pinnacle_editions (id text PRIMARY KEY);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.moments (
  id uuid PRIMARY KEY, edition_id uuid, serial_number int,
  collection_id uuid, nft_id text);
CREATE TABLE public.wallet_moments_cache (
  moment_id text, serial_number int, collection_id uuid, edition_key text);
CREATE TABLE public.cached_listings_v2 (
  flow_id bigint, edition_id uuid, completed_at timestamptz, listed_at timestamptz);

-- >>> BEGIN verbatim resolve_moment_id (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.resolve_moment_id(p_id text)
 RETURNS TABLE(kind text, moment_id uuid, edition_id uuid, serial_number integer, collection_id uuid, collection_slug text, pinnacle_edition_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uuid UUID;
  v_nft  BIGINT;
BEGIN
  RETURN QUERY
  SELECT 'pinnacle_edition'::TEXT,
         NULL::UUID,
         NULL::UUID,
         NULL::INT,
         (SELECT id FROM collections WHERE slug='disney_pinnacle'),
         'disney_pinnacle'::TEXT,
         pe.id
  FROM pinnacle_editions pe
  WHERE pe.id = p_id
  LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  BEGIN v_uuid := p_id::uuid; EXCEPTION WHEN OTHERS THEN v_uuid := NULL; END;

  IF v_uuid IS NOT NULL THEN
    RETURN QUERY
    SELECT 'moment'::TEXT, m.id, m.edition_id, m.serial_number,
           m.collection_id, c.slug::TEXT, NULL::TEXT
    FROM moments m
    JOIN collections c ON c.id = m.collection_id
    WHERE m.id = v_uuid
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    RETURN QUERY
    SELECT 'edition'::TEXT, NULL::UUID, e.id, NULL::INT,
           e.collection_id, c.slug::TEXT, NULL::TEXT
    FROM editions e
    JOIN collections c ON c.id = e.collection_id
    WHERE e.id = v_uuid
    LIMIT 1;
    RETURN;
  END IF;

  BEGIN v_nft := p_id::bigint; EXCEPTION WHEN OTHERS THEN v_nft := NULL; END;

  IF v_nft IS NOT NULL THEN
    RETURN QUERY
    SELECT 'moment'::TEXT, m.id, m.edition_id, m.serial_number,
           m.collection_id, c.slug::TEXT, NULL::TEXT
    FROM moments m
    JOIN collections c ON c.id = m.collection_id
    WHERE m.nft_id = v_nft::text
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- wmc fallback (2026-06-11): moments is a hydration cache and misses many
    -- held NFTs; wmc knows edition_key + serial for every tracked-wallet moment.
    -- Prefer Top Shot on cross-collection nft-id collisions; the editions join
    -- guarantees only resolvable rows return.
    RETURN QUERY
    SELECT 'moment'::TEXT, NULL::UUID, e.id, w.serial_number,
           w.collection_id, c.slug::TEXT, NULL::TEXT
    FROM wallet_moments_cache w
    JOIN collections c ON c.id = w.collection_id
    JOIN editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
    WHERE w.moment_id = p_id
    ORDER BY CASE WHEN w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN 0 ELSE 1 END
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;

    -- cached_listings_v2 fallback (2026-07-04): AllDay/Golazos secondary
    -- listings surface flow_ids for serials held by UNTRACKED wallets, so they
    -- are absent from both `moments` and `wallet_moments_cache` and the flat
    -- /moment/<flow_id> page 404'd on ~12k live AllDay listings. The live
    -- listing feed carries edition_id (direct FK to editions.id) but no serial,
    -- so resolve to the edition-level page (kind='edition') instead of a 404.
    -- Prefer an active listing, then the most recent, so a still-listed moment
    -- resolves before a completed one.
    RETURN QUERY
    SELECT 'edition'::TEXT, NULL::UUID, e.id, NULL::INT,
           e.collection_id, c.slug::TEXT, NULL::TEXT
    FROM cached_listings_v2 clv
    JOIN editions e ON e.id = clv.edition_id
    JOIN collections c ON c.id = e.collection_id
    WHERE clv.flow_id = v_nft
      AND clv.edition_id IS NOT NULL
    ORDER BY (clv.completed_at IS NULL) DESC, clv.listed_at DESC NULLS LAST
    LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  RETURN;
END;
$function$;
-- <<< END verbatim resolve_moment_id <<<

DO $seed$
DECLARE
  ts    uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';  -- nba_top_shot
  ad    uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';  -- nfl_all_day
  pin   uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';  -- disney_pinnacle
BEGIN
  INSERT INTO public.collections VALUES (ts,'nba_top_shot'),(ad,'nfl_all_day'),(pin,'disney_pinnacle');

  -- editions: TS+AllDay keyed for the wmc fallback; a standalone edition-by-uuid;
  -- two AllDay editions for the cached-listing active-vs-completed tie-break.
  INSERT INTO public.editions VALUES
    ('a0000000-0000-0000-0000-000000000001', ts, 'ekey-ts'),   -- wmc TS row
    ('a0000000-0000-0000-0000-000000000002', ad, 'ekey-ad'),   -- wmc AllDay row
    ('22222222-2222-2222-2222-222222222222', ts, 'ekey-eo'),   -- edition-by-uuid
    ('33333333-3333-3333-3333-333333333333', ad, 'ekey-clA'),  -- clv active
    ('44444444-4444-4444-4444-444444444444', ad, 'ekey-clD');  -- clv completed

  -- moment A: hit by both its UUID (scenario 2) and its nft_id 700700 (scenario 4)
  INSERT INTO public.moments VALUES
    ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000001',7,ts,'700700');

  -- pinnacle render id (text, non-uuid, non-numeric) → scenario 1
  INSERT INTO public.pinnacle_editions VALUES ('pin-xyz');

  -- wmc fallback (bigint 800800 absent from moments): TS + AllDay collision,
  -- TS must win → serial 5 from the TS row.
  INSERT INTO public.wallet_moments_cache VALUES
    ('800800', 5, ts, 'ekey-ts'),
    ('800800', 9, ad, 'ekey-ad');

  -- cached-listing fallback (bigint 900900 absent from moments+wmc): a COMPLETED
  -- row (older) and an ACTIVE row (newer) — active must win regardless of order.
  INSERT INTO public.cached_listings_v2 VALUES
    (900900, '44444444-4444-4444-4444-444444444444', now() - interval '1 day', now() - interval '2 day'),
    (900900, '33333333-3333-3333-3333-333333333333', NULL, now() - interval '3 day');
END $seed$;

-- 1. pinnacle render id resolves as pinnacle_edition (branch 1, before uuid/bigint)
SELECT _assert_eq((SELECT kind FROM resolve_moment_id('pin-xyz')), 'pinnacle_edition', 'text id → pinnacle_edition');
SELECT _assert_eq((SELECT pinnacle_edition_id FROM resolve_moment_id('pin-xyz')), 'pin-xyz', 'pinnacle_edition_id carried through');

-- 2. moments UUID → kind moment, with serial
SELECT _assert_eq((SELECT kind FROM resolve_moment_id('11111111-1111-1111-1111-111111111111')), 'moment', 'moments UUID → moment');
SELECT _assert_eq((SELECT serial_number::text FROM resolve_moment_id('11111111-1111-1111-1111-111111111111')), '7', 'moment UUID serial');

-- 3. editions UUID (not a moment) → kind edition
SELECT _assert_eq((SELECT kind FROM resolve_moment_id('22222222-2222-2222-2222-222222222222')), 'edition', 'editions UUID → edition');
SELECT _assert_eq((SELECT edition_id::text FROM resolve_moment_id('22222222-2222-2222-2222-222222222222')), '22222222-2222-2222-2222-222222222222', 'edition id echoed');

-- 4. numeric nft_id present in moments → kind moment
SELECT _assert_eq((SELECT kind FROM resolve_moment_id('700700')), 'moment', 'nft_id → moment');
SELECT _assert_eq((SELECT serial_number::text FROM resolve_moment_id('700700')), '7', 'nft_id moment serial');

-- 5. wmc fallback with a cross-collection collision — Top Shot wins the tie
SELECT _assert_eq((SELECT kind FROM resolve_moment_id('800800')), 'moment', 'wmc fallback → moment');
SELECT _assert_eq((SELECT collection_slug FROM resolve_moment_id('800800')), 'nba_top_shot', 'wmc collision resolves to Top Shot');
SELECT _assert_eq((SELECT serial_number::text FROM resolve_moment_id('800800')), '5', 'wmc TS row serial (not the AllDay 9)');

-- 6. cached-listing fallback prefers the OPEN listing over the completed one
SELECT _assert_eq((SELECT kind FROM resolve_moment_id('900900')), 'edition', 'cached-listing fallback → edition');
SELECT _assert_eq((SELECT edition_id::text FROM resolve_moment_id('900900')), '33333333-3333-3333-3333-333333333333', 'active listing (completed_at NULL) wins over completed');

-- 7. unknown ids return no rows (numeric miss and text miss)
SELECT _assert_eq((SELECT count(*)::text FROM resolve_moment_id('123456789')), '0', 'unknown numeric id → no rows');
SELECT _assert_eq((SELECT count(*)::text FROM resolve_moment_id('no-such-id')), '0', 'unknown text id → no rows');

SELECT '✓ resolve_moment_id invariants pass' AS result;
ROLLBACK;
