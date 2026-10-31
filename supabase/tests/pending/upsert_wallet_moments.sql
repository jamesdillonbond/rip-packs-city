-- ⏳ PENDING PIN — NOT YET LIVE. Parked here (not in supabase/tests/, which every
-- walker reads non-recursively) because migration 20261031150000 was written and
-- committed on 2026-10-31 but its apply was refused for the cloud session that
-- wrote it (the MCP write confirmation auto-cancelled / auto-mode classifier
-- denied the CREATE OR REPLACE — three attempts, 7:52–7:58 AM PT). The live
-- function is still the 20260802000400 body and the pin in supabase/tests/ still
-- matches it, so drift-guard and db-pin-staleness read true.
--
-- FOLLOW-UP, the moment the migration is applied (apply_migration, name
-- audit_20261031_upsert_wallet_moments_league_team_label_or, body = the committed
-- file verbatim; rename the file to the recorded version if it differs):
--   git mv supabase/tests/pending/upsert_wallet_moments.sql supabase/tests/upsert_wallet_moments.sql
--   # __tests__/db-invariants-drift-guard.test.ts, the upsert_wallet_moments row:
--   #   migration: "supabase/migrations/20261031150000_audit_20261031_upsert_wallet_moments_league_team_label_or.sql"
--   # then delete this banner (everything above the first "-- DB invariant:" line),
--   # run the DB suite + `npx vitest run __tests__/db-invariants-drift-guard.test.ts`, commit.
-- Verified 10-31 against a throwaway Postgres 16: passes; two planted defects
-- (team arm disabled; collection scope dropped) each red it.

-- DB invariant: public.upsert_wallet_moments(text,uuid,jsonb) — the wmc ownership
-- writer a wallet-sync calls with a wallet's CURRENT moments. Pinned properties:
-- the wallet address is lowercased; Top Shot moments are league-classified
-- (the edition's TEAM label — teams_master WNBA + historic labels, resolved
-- through `editions` by the payload's edition_key — OR a WNBA set-name / curated
-- list → 'WNBA', else 'NBA'; an unknown edition falls back to the set rule;
-- non-Top-Shot → NULL) — #219, 2026-10-31; a re-upsert of the same moment
-- refreshes fmv but COALESCEs name/image/metadata (never nulls them out); and —
-- the subtle one — "sync = replace": after upserting the payload it REAPS this
-- wallet+collection's rows older than 5 minutes, so a moment no longer held
-- disappears while the payload's rows (stamped NOW) survive and OTHER wallets
-- are never touched.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261031150000_audit_20261031_upsert_wallet_moments_league_team_label_or.sql);
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

-- The two tables the league rule reads (#219): the team registry and the
-- edition the payload's edition_key points at.
CREATE TABLE teams_master (team_name text, league text);
INSERT INTO teams_master VALUES ('New York Liberty','WNBA'), ('Las Vegas Aces','WNBA'), ('Denver Nuggets','NBA');
CREATE TABLE editions (external_id text, collection_id uuid, team_name text);
INSERT INTO editions VALUES
  ('ed_liberty_vv', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'New York Liberty'),   -- WNBA team in a MIXED set
  ('ed_nuggets_vv', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Denver Nuggets'),     -- NBA team in the same set
  ('ed_comets',     '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Houston Comets'),     -- historic label, not in teams_master
  ('ed_liberty_vv', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'New York Liberty'),   -- same key, OTHER collection (must not match)
  ('ed_ad_only',    'dee28451-5d62-409e-a1ad-a83f763ac070', 'New York Liberty');   -- a WNBA label that exists ONLY in All Day

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
  v_edition_key text;
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
  -- WNBA team labels: the registry (teams_master, league = 'WNBA') plus the
  -- historic / all-star labels Top Shot still prints on moments. Read once per
  -- call, Top Shot only. Mirrors topshot_squeeze_board (20261031040755).
  v_wnba_labels text[] := ARRAY[]::text[];
BEGIN
  IF p_collection_id = v_topshot_id THEN
    SELECT COALESCE(array_agg(t.team_name), ARRAY[]::text[]) INTO v_wnba_labels
    FROM (
      SELECT team_name FROM teams_master WHERE league = 'WNBA'
      UNION
      SELECT unnest(ARRAY[
        'San Antonio Stars','San Antonio Silver Stars','Utah Starzz','Detroit Shock',
        'Tulsa Shock','Orlando Miracle','Houston Comets','Sacramento Monarchs',
        'Charlotte Sting','Cleveland Rockers','Miami Sol','Team Wilson','Team Stewart'
      ])
    ) t;
  END IF;

  FOR v_moment IN SELECT * FROM jsonb_array_elements(p_moments)
  LOOP
    v_set_name := v_moment->>'set_name';
    v_edition_key := v_moment->>'edition_key';

    -- Compute league only for Top Shot; other collections leave it NULL.
    -- The moment's TEAM label decides first (WNBA moments live in mixed sets
    -- too — #219), then the set rule; an unknown edition falls back to the set
    -- rule, so a Top Shot row is never NULL here.
    IF p_collection_id = v_topshot_id THEN
      IF v_set_name ILIKE '%WNBA%' OR v_set_name = ANY(v_wnba_only_sets) THEN
        v_league := 'WNBA';
      ELSIF v_edition_key IS NOT NULL AND EXISTS (
        SELECT 1 FROM editions e
        WHERE e.external_id = v_edition_key
          AND e.collection_id = p_collection_id
          AND e.team_name = ANY(v_wnba_labels)
      ) THEN
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
      v_edition_key,
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

-- ── league classification (Top Shot): set rule ──────────────────────────────
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_wnba'),
  'WNBA', 'WNBA set name → WNBA league');
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_nba'),
  'NBA', 'regular Top Shot set → NBA league');

-- ── league classification (Top Shot): the TEAM label decides in a MIXED set (#219) ─
-- Four moments in "Vintage Vibes" (a set the set rule reads as NBA): a Liberty
-- edition (registry WNBA), a Nuggets edition (NBA), a Comets edition (historic
-- WNBA label, absent from teams_master) and an edition_key the editions table
-- does not know. Also a payload row with NO edition_key at all.
SELECT upsert_wallet_moments('0xabc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '[
  {"moment_id":"m_keep"},{"moment_id":"m_wnba"},{"moment_id":"m_nba"},
  {"moment_id":"m_curated","set_name":"Rise With Us","fmv_usd":9},
  {"moment_id":"m_liberty","edition_key":"ed_liberty_vv","set_name":"Vintage Vibes","fmv_usd":40},
  {"moment_id":"m_nuggets","edition_key":"ed_nuggets_vv","set_name":"Vintage Vibes","fmv_usd":40},
  {"moment_id":"m_comets","edition_key":"ed_comets","set_name":"Vintage Vibes","fmv_usd":40},
  {"moment_id":"m_unknown_ed","edition_key":"ed_nobody_knows","set_name":"Vintage Vibes","fmv_usd":40},
  {"moment_id":"m_no_key","set_name":"Vintage Vibes","fmv_usd":40},
  {"moment_id":"m_other_coll_key","edition_key":"ed_ad_only","set_name":"Vintage Vibes","fmv_usd":40}
]'::jsonb);
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_curated'),
  'WNBA', 'curated WNBA-only set name → WNBA league');
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_liberty'),
  'WNBA', 'a WNBA team label in a mixed set → WNBA (the team decides, not the set)');
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_nuggets'),
  'NBA', 'an NBA team label in the same mixed set → NBA');
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_comets'),
  'WNBA', 'a historic WNBA label absent from teams_master → WNBA');
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_unknown_ed'),
  'NBA', 'an edition_key the editions table does not know falls back to the set rule');
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_no_key'),
  'NBA', 'no edition_key → the set rule, never NULL for Top Shot');
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_other_coll_key'),
  'NBA', 'the edition lookup is COLLECTION-scoped: a key known only to All Day does not decide a Top Shot row');

-- ── a re-upsert RE-STAMPS league (the rule is recomputed every refresh) ─────
UPDATE wallet_moments_cache SET league = 'NBA' WHERE wallet_address='0xabc' AND moment_id='m_liberty';
SELECT upsert_wallet_moments('0xabc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '[
  {"moment_id":"m_keep"},{"moment_id":"m_wnba"},{"moment_id":"m_nba"},{"moment_id":"m_curated"},
  {"moment_id":"m_liberty","edition_key":"ed_liberty_vv","set_name":"Vintage Vibes"},
  {"moment_id":"m_nuggets"},{"moment_id":"m_comets"},{"moment_id":"m_unknown_ed"},{"moment_id":"m_no_key"},{"moment_id":"m_other_coll_key"}
]'::jsonb);
SELECT _assert_eq((SELECT league FROM wallet_moments_cache WHERE wallet_address='0xabc' AND moment_id='m_liberty'),
  'WNBA', 'a misfiled NBA row is corrected on its next sync');

-- ── non-Top-Shot → NULL league, even when the edition_key matches a WNBA label in
--    ANOTHER collection (the lookup is collection-scoped) ─────────────────────
SELECT upsert_wallet_moments('0xdef', 'dee28451-5d62-409e-a1ad-a83f763ac070', '[
  {"moment_id":"m_ad","edition_key":"ed_liberty_vv","set_name":"Base Set","fmv_usd":3}
]'::jsonb);
SELECT _assert_eq((SELECT league IS NULL FROM wallet_moments_cache WHERE wallet_address='0xdef' AND moment_id='m_ad')::text,
  'true', 'non-Top-Shot collection leaves league NULL');

SELECT '✓ upsert_wallet_moments invariants pass' AS result;
ROLLBACK;
