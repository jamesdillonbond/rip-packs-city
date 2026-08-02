-- DB invariant: public.upsert_wallet_moments(text,uuid,jsonb) — the wmc ownership
-- writer a wallet-sync calls with a wallet's CURRENT moments. Pinned properties:
-- the wallet address is lowercased; Top Shot moments are league-classified
-- (WNBA set-name / curated list → 'WNBA', else 'NBA'; non-Top-Shot → NULL); a
-- re-upsert of the same moment refreshes fmv but COALESCEs name/image/metadata
-- (never nulls them out); and — the subtle one — "sync = replace": after upserting
-- the payload it REAPS this wallet+collection's rows older than 5 minutes, so a
-- moment no longer held disappears while the payload's rows (stamped NOW) survive
-- and OTHER wallets are never touched.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802000400_audit_20260802_snapshot_upsert_wallet_moments.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE wallet_moments_cache (
  id             uuid,
  wallet_address text,
  collection_id  uuid,
  moment_id      text,
  edition_key    text,
  edition_name   text,
  player_name    text,
  character_name text,
  set_name       text,
  tier           text,
  serial_number  int,
  mint_count     int,
  fmv_usd        numeric,
  image_url      text,
  is_locked      boolean,
  acquired_at    timestamptz,
  last_seen_at   timestamptz,
  created_at     timestamptz,
  metadata       jsonb,
  league         text,
  UNIQUE (wallet_address, collection_id, moment_id)
);

-- >>> BEGIN verbatim upsert_wallet_moments (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.upsert_wallet_moments(p_wallet_address text, p_collection_id uuid, p_moments jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_upserted INT := 0;
  v_moment JSONB;
  v_set_name text;
  v_league text;
  v_topshot_id constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_wnba_only_sets constant text[] := ARRAY[
    'Rise With Us',
    'Rise With Us 2023',
    'In Her Bag',
    'In Their Bag',
    'Shining Stars',
    'Chasing the Trophy',
    'For the Cup'
  ];
BEGIN
  FOR v_moment IN SELECT * FROM jsonb_array_elements(p_moments)
  LOOP
    v_set_name := v_moment->>'set_name';

    -- Compute league only for Top Shot; other collections leave it NULL.
    IF p_collection_id = v_topshot_id THEN
      IF v_set_name ILIKE '%WNBA%' OR v_set_name = ANY(v_wnba_only_sets) THEN
        v_league := 'WNBA';
      ELSE
        v_league := 'NBA';
      END IF;
    ELSE
      v_league := NULL;
    END IF;

    INSERT INTO wallet_moments_cache (
      id, wallet_address, collection_id, moment_id, edition_key, edition_name,
      player_name, character_name, set_name, tier, serial_number, mint_count,
      fmv_usd, image_url, is_locked, acquired_at, last_seen_at, created_at,
      metadata, league
    ) VALUES (
      gen_random_uuid(),
      lower(p_wallet_address),
      p_collection_id,
      v_moment->>'moment_id',
      v_moment->>'edition_key',
      v_moment->>'edition_name',
      v_moment->>'player_name',
      v_moment->>'character_name',
      v_set_name,
      v_moment->>'tier',
      (v_moment->>'serial_number')::int,
      (v_moment->>'mint_count')::int,
      (v_moment->>'fmv_usd')::numeric,
      v_moment->>'image_url',
      COALESCE((v_moment->>'is_locked')::boolean, false),
      (v_moment->>'acquired_at')::timestamptz,
      NOW(),
      NOW(),
      v_moment->'metadata',
      v_league
    )
    ON CONFLICT (wallet_address, collection_id, moment_id)
    DO UPDATE SET
      fmv_usd = EXCLUDED.fmv_usd,
      edition_name = COALESCE(EXCLUDED.edition_name, wallet_moments_cache.edition_name),
      player_name = COALESCE(EXCLUDED.player_name, wallet_moments_cache.player_name),
      character_name = COALESCE(EXCLUDED.character_name, wallet_moments_cache.character_name),
      image_url = COALESCE(EXCLUDED.image_url, wallet_moments_cache.image_url),
      is_locked = EXCLUDED.is_locked,
      last_seen_at = NOW(),
      metadata = COALESCE(EXCLUDED.metadata, wallet_moments_cache.metadata),
      -- League is recomputed every refresh — corrects any stale rows when curated list expands
      league = COALESCE(EXCLUDED.league, wallet_moments_cache.league);

    v_upserted := v_upserted + 1;
  END LOOP;

  DELETE FROM wallet_moments_cache
  WHERE lower(wallet_address) = lower(p_wallet_address)
    AND collection_id = p_collection_id
    AND last_seen_at < NOW() - INTERVAL '5 minutes';

  RETURN jsonb_build_object(
    'upserted', v_upserted,
    'wallet', lower(p_wallet_address),
    'collection_id', p_collection_id
  );
END;
$function$;
-- <<< END verbatim upsert_wallet_moments <<<

-- ── Pre-existing (stale) rows: a prior sync's cache for 0xabc + one other wallet ─
-- m_old: 0xabc holds it in the cache but it is NOT in the new payload → must be reaped.
-- m_keep: 0xabc, stale timestamp, but IS in the new payload → refreshed, survives.
-- m_other: a DIFFERENT wallet, stale → must NOT be touched by 0xabc's sync.
INSERT INTO wallet_moments_cache (id, wallet_address, collection_id, moment_id, player_name, fmv_usd, last_seen_at, created_at)
VALUES
  (gen_random_uuid(), '0xabc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm_old',  'Old Player',  10, now() - interval '10 minutes', now()),
  (gen_random_uuid(), '0xabc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm_keep', 'Keep Player', 20, now() - interval '10 minutes', now()),
  (gen_random_uuid(), '0xzzz', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm_other','Other Player',30, now() - interval '10 minutes', now());

-- New sync for 0xABC (mixed case → must be stored lowercase): keeps m_keep (new fmv,
-- but NULL player_name must not overwrite), adds m_wnba (WNBA set) and m_nba (regular).
SELECT _assert_eq(
  (upsert_wallet_moments('0xABC', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '[
     {"moment_id":"m_keep","fmv_usd":25},
     {"moment_id":"m_wnba","set_name":"2024 WNBA Playoffs","player_name":"A. Wilson","fmv_usd":50},
     {"moment_id":"m_nba","set_name":"Base Set","player_name":"L. James","fmv_usd":5}
   ]'::jsonb)->>'upserted'),
  '3', 'reports 3 upserts');

-- ── wallet stored lowercase ─────────────────────────────────────────────────
SELECT _assert_eq((SELECT count(DISTINCT wallet_address)::text FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id IN ('m_keep','m_wnba','m_nba')),
  '1', 'wallet address lowercased on write');
SELECT _assert_eq((SELECT count(*)::text FROM wallet_moments_cache WHERE wallet_address='0xABC'), '0',
  'no mixed-case row is ever written');

-- ── sync=replace: m_old reaped, m_keep + others survive ─────────────────────
SELECT _assert_eq((SELECT count(*)::text FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_old'),
  '0', 'stale moment absent from payload is reaped');
SELECT _assert_eq((SELECT count(*)::text FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_keep'),
  '1', 'payload moment survives the reap');
SELECT _assert_eq((SELECT count(*)::text FROM wallet_moments_cache WHERE wallet_address='0xzzz' AND moment_id='m_other'),
  '1', 'another wallet''s stale row is untouched');

-- ── conflict update: fmv refreshed, NULL player_name does NOT overwrite ──────
SELECT _assert_eq((SELECT fmv_usd::text FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_keep'),
  '25', 'fmv refreshed on re-upsert');
SELECT _assert_eq((SELECT player_name FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_keep'),
  'Keep Player', 'a NULL player_name in the payload does not clear the existing one');

-- ── league classification (Top Shot) ────────────────────────────────────────
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_wnba'),
  'WNBA', 'WNBA set name → WNBA league');
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_nba'),
  'NBA', 'regular Top Shot set → NBA league');

-- ── curated WNBA-only set name → WNBA, and non-Top-Shot → NULL league ───────
SELECT upsert_wallet_moments('0xabc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '[
  {"moment_id":"m_keep"},{"moment_id":"m_wnba"},{"moment_id":"m_nba"},
  {"moment_id":"m_curated","set_name":"Rise With Us","fmv_usd":9}
]'::jsonb);
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_curated'),
  'WNBA', 'curated WNBA-only set name → WNBA league');
SELECT upsert_wallet_moments('0xdef', 'dee28451-5d62-409e-a1ad-a83f763ac070', '[
  {"moment_id":"m_ad","set_name":"Base Set","fmv_usd":3}
]'::jsonb);
SELECT _assert_eq((SELECT league IS NULL FROM wallet_moments_cache WHERE wallet_address='0xdef' AND moment_id='m_ad')::text,
  'true', 'non-Top-Shot collection leaves league NULL');

SELECT '✓ upsert_wallet_moments invariants pass' AS result;
ROLLBACK;
