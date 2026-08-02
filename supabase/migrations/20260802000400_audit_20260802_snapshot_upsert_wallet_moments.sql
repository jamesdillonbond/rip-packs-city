-- Snapshot migration: commit the VERBATIM live body of public.upsert_wallet_moments
-- so the DB-invariant test (supabase/tests/upsert_wallet_moments.sql) has a committed
-- source the drift guard can compare against. MCP-applied (its committed migrations
-- only REVOKE/harden it, none redefine the current body) → previously UNPINNABLE;
-- byte-identical snapshot per the documented remedy (CLAUDE.md "Testing & CI coverage").
--
-- upsert_wallet_moments is the wmc (wallet_moments_cache) ownership writer that a
-- wallet-sync calls with the wallet's current moments. Two non-obvious properties
-- make it correct: (1) it applies "sync = replace" semantics — after upserting the
-- payload it REAPS this wallet+collection's rows whose last_seen_at is older than
-- 5 minutes, so a moment the wallet no longer holds disappears while the ones in
-- the payload (just stamped NOW) survive and OTHER wallets are untouched; (2) it
-- classifies Top Shot moments as WNBA vs NBA by set name and leaves league NULL for
-- other collections. Re-applying this is a no-op (CREATE OR REPLACE, live source).

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
