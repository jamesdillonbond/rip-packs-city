-- audit_20261031_upsert_wallet_moments_keeps_a_lock_flag_it_was_not_given
--
-- 2026-10-31 ~9:30 PM PT (Claude Code cloud; Trevor: "Keep going"; known-issue #222). Naming the
-- writers of wallet_moments_cache.is_locked found this one: ON CONFLICT set is_locked =
-- EXCLUDED.is_locked, and EXCLUDED is COALESCE(payload, false) — so the wallet-save seed
-- (/api/wallet/seed sends is_locked:false for every moment, read from nowhere) overwrote real
-- locks with false and left lock_checked_at on its old stamp. Now the flag changes only when the
-- payload carries an explicit boolean; the seed route stops sending one. A NEW row still defaults
-- to false with lock_checked_at NULL (unchecked — readers gate on the stamp).
-- Body = 20261031161800's verbatim (live prosrc md5 b78f73412f1a830b57786ba3ed6cf6d2 verified equal)
-- plus the one hunk marked 2026-10-31 (#222).
-- APPLIED AS an md5-gated anchor-replace DO block over that base, which refused to run unless the
-- result's md5 equalled the literal body below; read back after apply.
-- anon-exec: unchanged (upsert_wallet_moments) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false.
-- REVERT: re-apply the upsert_wallet_moments block of
--   supabase/migrations/20261031161800_audit_20261031_upsert_wallet_moments_league_team_label_or.sql verbatim.

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
      -- 2026-10-31 (#222): the lock flag changes only when the payload CARRIES one. The wallet-save
      -- seed sent is_locked:false for every moment without reading the chain, and this line copied
      -- it over real locks while lock_checked_at kept its old stamp — a "checked" false nobody read.
      is_locked = CASE WHEN jsonb_typeof(v_moment -> 'is_locked') = 'boolean'
                       THEN EXCLUDED.is_locked ELSE wallet_moments_cache.is_locked END,
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
