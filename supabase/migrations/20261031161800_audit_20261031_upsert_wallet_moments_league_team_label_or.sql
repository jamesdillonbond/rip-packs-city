-- audit_20261031_upsert_wallet_moments_league_team_label_or
-- anon-exec: unchanged (upsert_wallet_moments) — CREATE OR REPLACE keeps the existing ACL (anon/authenticated EXECUTE revoked by 20260502210000; service_role calls it).
--
-- APPLIED 2026-10-31 09:18 AM PT through the dashboard SQL editor in Trevor's Chrome
-- (every MCP write route was refused for the cloud session — apply_migration
-- auto-cancelled ×5, execute_sql DDL and the one-off pg_cron route denied by the
-- auto-mode classifier — until Trevor switched the session to manual approval);
-- buffer loaded by fetch of the committed file at c1676ab, SHA-256-checked before
-- setValue. schema_migrations row 20261031161800 inserted by hand (parity matches
-- on NAME). Verified live: prosrc md5 b78f73412f1a830b57786ba3ed6cf6d2, misfiled
-- rows 719 → 0, WNBA wmc rows 80,031 → 80,750 (+719), anon/authenticated EXECUTE
-- still false, service_role true.
--
-- Known issue #219, the write side. `wallet_moments_cache.league` (the column the
-- collection page's NBA / WNBA filter, the profile trophy picker and the
-- concierge read) is written ONLY by this function (pg_proc grep 10-31: no other
-- writer touches `league`), and until now it decided WNBA from the SET NAME
-- alone (`ILIKE '%WNBA%'` or a curated WNBA-only list). Top Shot files WNBA
-- moments into mixed sets too — Fresh Gems, Level Up, Road To Royalty,
-- Signature Style, Throne Room, Vintage Vibes — so a New York Liberty moment in
-- "Vintage Vibes" was stamped NBA and disappeared from every "WNBA" view: 719
-- live rows across 13 WNBA franchises (Liberty 216, Mystics 105, Sparks 63 …),
-- read 10-31 7:50 AM PT.
--
-- Fix: the same OR the squeeze views (20261031040755) and the Sniper
-- (`lib/league.ts leagueForEdition`, c643a63) now apply — the moment's TEAM
-- label decides first, then the set rule. The payload a wallet-sync sends has
-- no team, so the team is read from `editions` by the payload's `edition_key`
-- (= editions.external_id, unique with collection_id — an index point-lookup per
-- moment). The WNBA label set is read ONCE per call from `teams_master`
-- (league = 'WNBA') plus the historic / all-star labels the squeeze view carries
-- (franchises that no longer exist are not in teams_master). A moment with no
-- edition_key, or one whose edition is unknown, falls back to the set rule —
-- never NULL for Top Shot, exactly as before.
--
-- The body below is the pinned copy in supabase/tests/upsert_wallet_moments.sql
-- (live prosrc md5 a22eee707f5010df95b5ecbfbb50325f == pin, verified before this
-- CREATE OR REPLACE) with the league block changed and nothing else. Grants,
-- SECURITY DEFINER and search_path are unchanged (restated by the header).
--
-- Then a ONE-OFF re-stamp of the rows the old rule misfiled: every Top Shot wmc
-- row whose edition's team is a WNBA label and whose league reads 'NBA'. The
-- function recomputes league on every refresh, so a wallet's next sync would
-- correct its rows anyway; the re-stamp just does not make readers wait for it.
--
-- Revert: re-apply the body from 20260802000400 (set rule only); the re-stamped
-- rows then read WNBA until a sync rewrites them, which is the CORRECT reading,
-- so there is nothing to undo on the data side.

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

COMMENT ON FUNCTION public.upsert_wallet_moments(text, uuid, jsonb) IS
  'wmc full-set writer (sync = replace). league (Top Shot only): the edition''s TEAM label (teams_master WNBA + historic labels, via edition_key) OR the set rule — #219, 2026-10-31. Pinned: supabase/tests/upsert_wallet_moments.sql.';

-- One-off re-stamp of the rows the set rule misfiled (719 at 10-31 7:50 AM PT).
-- Scoped to Top Shot rows reading 'NBA' whose edition carries a WNBA label.
UPDATE wallet_moments_cache w
SET league = 'WNBA'
FROM editions e
WHERE e.external_id = w.edition_key
  AND e.collection_id = w.collection_id
  AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND w.league = 'NBA'
  AND e.team_name IN (
    SELECT team_name FROM teams_master WHERE league = 'WNBA'
    UNION
    SELECT unnest(ARRAY[
      'San Antonio Stars','San Antonio Silver Stars','Utah Starzz','Detroit Shock',
      'Tulsa Shock','Orlando Miracle','Houston Comets','Sacramento Monarchs',
      'Charlotte Sting','Cleveland Rockers','Miami Sol','Team Wilson','Team Stewart'
    ])
  );

-- Post-flight: no Top Shot row with a WNBA-labelled edition still reads NBA.
DO $$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left
  FROM wallet_moments_cache w
  JOIN editions e ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
  WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND w.league = 'NBA'
    AND e.team_name IN (SELECT team_name FROM teams_master WHERE league = 'WNBA');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'upsert_wallet_moments league re-stamp left % WNBA-labelled Top Shot rows reading NBA', v_left;
  END IF;
END $$;
