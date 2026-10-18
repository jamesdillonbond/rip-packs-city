-- audit_20261018 — resolve_wallet_verification_challenges also matches the ON-CHAIN book.
--
-- WHY. Listing-challenge wallet verification matched only v1 `cached_listings`
-- (storefront_address + exact ask). For NFL All Day and LaLiga Golazos v1 holds
-- only Flowty's slice (108 / 100 rows on 2026-10-18), so a wallet holding only
-- those collections could not verify by listing, and on the day Flowty's API
-- goes dark no All Day / Golazos listing could verify anyone. Usage is rare
-- (9 challenges ever, 0 open today), which is why this was left on v1 earlier
-- the same day; it is small and contained, so it is closed rather than carried.
--
-- WHAT CHANGES. A second candidate leg over cached_listings_v2 (open, unexpired,
-- seller_address + exact price_usd, AND listed after the challenge was issued),
-- per challenge via LATERAL, so with no open challenge it reads nothing. The v1
-- leg, the expiry housekeeping, the saved_wallets update, the output shape,
-- SECURITY DEFINER, search_path, statement_timeout and ACL are unchanged.
-- Flow addresses only: v2 holds Flow listings, so LOWER() is the existing,
-- correct normalisation here (a Solana key never matches a Flow seller).
--
-- This function had NO migration in the repo; the live body (md5(prosrc)
-- 11c6c856d329c56caddca2ab919e5476) is recorded below verbatim for revert.
-- anon-exec: unchanged (resolve_wallet_verification_challenges) — CREATE OR REPLACE of an existing fn; ACL preserved (service_role only), checked below.
--
-- REVERT (verbatim live DDL before this migration):
--   CREATE OR REPLACE FUNCTION public.resolve_wallet_verification_challenges()
--    RETURNS TABLE(challenge_id uuid, user_id uuid, wallet_addr text, challenge_amount numeric, matched_moment_id text, matched_source text)
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--    SET statement_timeout TO '15s'
--   AS $function$
--   DECLARE
--     v_now TIMESTAMPTZ := now();
--   BEGIN
--     -- Expire stale challenges first (housekeeping)
--     UPDATE wallet_verification_challenges
--     SET resolved_at = v_now,
--         resolved_via = 'expired'
--     WHERE resolved_at IS NULL
--       AND expires_at < v_now;
--   
--     -- Find unresolved challenges that have a matching listing in cached_listings
--     RETURN QUERY
--     WITH matches AS (
--       SELECT DISTINCT ON (wvc.id)
--         wvc.id           AS challenge_id,
--         wvc.user_id,
--         wvc.wallet_addr,
--         wvc.challenge_amount,
--         cl.moment_id     AS matched_moment_id,
--         cl.source        AS matched_source
--       FROM wallet_verification_challenges wvc
--       JOIN cached_listings cl
--         ON LOWER(cl.storefront_address) = LOWER(wvc.wallet_addr)
--        AND cl.ask_price = wvc.challenge_amount
--       WHERE wvc.resolved_at IS NULL
--         AND wvc.expires_at >= v_now
--       ORDER BY wvc.id, cl.cached_at DESC
--     ),
--     resolved AS (
--       UPDATE wallet_verification_challenges wvc
--       SET resolved_at       = v_now,
--           resolved_via      = m.matched_source,
--           matched_moment_id = m.matched_moment_id
--       FROM matches m
--       WHERE wvc.id = m.challenge_id
--       RETURNING wvc.id, wvc.user_id, wvc.wallet_addr, wvc.challenge_amount,
--                 wvc.matched_moment_id, wvc.resolved_via
--     ),
--     -- Verify all saved_wallets rows for this (user, wallet) pair across all collections
--     verified AS (
--       UPDATE saved_wallets sw
--       SET verified_at         = v_now,
--           verification_method = 'listing_challenge'
--       FROM resolved r
--       WHERE sw.user_id = r.user_id
--         AND LOWER(sw.wallet_addr) = LOWER(r.wallet_addr)
--         AND sw.verified_at IS NULL
--       RETURNING sw.id
--     )
--     SELECT r.id, r.user_id, r.wallet_addr, r.challenge_amount,
--            r.matched_moment_id, r.resolved_via
--     FROM resolved r;
--   END;
--   $function$;

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'resolve_wallet_verification_challenges' AND pronamespace = 'public'::regnamespace) <> '11c6c856d329c56caddca2ab919e5476' THEN
    RAISE EXCEPTION 'resolve_wallet_verification_challenges live body is not the one this migration was built from';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.resolve_wallet_verification_challenges()
 RETURNS TABLE(challenge_id uuid, user_id uuid, wallet_addr text, challenge_amount numeric, matched_moment_id text, matched_source text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '15s'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  -- Expire stale challenges first (housekeeping)
  UPDATE wallet_verification_challenges
  SET resolved_at = v_now,
      resolved_via = 'expired'
  WHERE resolved_at IS NULL
    AND expires_at < v_now;

  -- Find unresolved challenges that have a matching listing. Two books:
  --   * v1 cached_listings — Top Shot's own feed (Atlas), storefront-addressed;
  --   * cached_listings_v2 — the on-chain book (All Day, Golazos, ...), added
  --     2026-10-18: v1 holds only Flowty's slice for those collections, so a
  --     wallet holding only All Day or Golazos could not verify by listing.
  --     The v2 leg also requires the listing to postdate the challenge, so a
  --     pre-existing ask at the same price cannot verify a wallet by accident.
  --     It is a per-challenge LATERAL: with no open challenge it reads nothing.
  RETURN QUERY
  WITH cand AS (
    SELECT
      wvc.id           AS challenge_id,
      wvc.user_id,
      wvc.wallet_addr,
      wvc.challenge_amount,
      cl.moment_id     AS matched_moment_id,
      cl.source        AS matched_source,
      cl.cached_at     AS seen_at
    FROM wallet_verification_challenges wvc
    JOIN cached_listings cl
      ON LOWER(cl.storefront_address) = LOWER(wvc.wallet_addr)
     AND cl.ask_price = wvc.challenge_amount
    WHERE wvc.resolved_at IS NULL
      AND wvc.expires_at >= v_now
    UNION ALL
    SELECT
      wvc.id, wvc.user_id, wvc.wallet_addr, wvc.challenge_amount,
      v2.flow_id::text, v2.source, v2.listed_at
    FROM wallet_verification_challenges wvc
    CROSS JOIN LATERAL (
      SELECT c2.flow_id, c2.source, c2.listed_at
        FROM cached_listings_v2 c2
       WHERE c2.completed_at IS NULL
         AND LOWER(c2.seller_address) = LOWER(wvc.wallet_addr)
         AND c2.price_usd = wvc.challenge_amount
         AND c2.listed_at >= wvc.created_at
         AND (c2.expiry_at IS NULL OR c2.expiry_at > v_now)
       ORDER BY c2.listed_at DESC
       LIMIT 1
    ) v2
    WHERE wvc.resolved_at IS NULL
      AND wvc.expires_at >= v_now
  ),
  matches AS (
    SELECT DISTINCT ON (c.challenge_id)
      c.challenge_id, c.user_id, c.wallet_addr, c.challenge_amount,
      c.matched_moment_id, c.matched_source
    FROM cand c
    ORDER BY c.challenge_id, c.seen_at DESC NULLS LAST
  ),
  resolved AS (
    UPDATE wallet_verification_challenges wvc
    SET resolved_at       = v_now,
        resolved_via      = m.matched_source,
        matched_moment_id = m.matched_moment_id
    FROM matches m
    WHERE wvc.id = m.challenge_id
    RETURNING wvc.id, wvc.user_id, wvc.wallet_addr, wvc.challenge_amount,
              wvc.matched_moment_id, wvc.resolved_via
  ),
  -- Verify all saved_wallets rows for this (user, wallet) pair across all collections
  verified AS (
    UPDATE saved_wallets sw
    SET verified_at         = v_now,
        verification_method = 'listing_challenge'
    FROM resolved r
    WHERE sw.user_id = r.user_id
      AND LOWER(sw.wallet_addr) = LOWER(r.wallet_addr)
      AND sw.verified_at IS NULL
    RETURNING sw.id
  )
  SELECT r.id, r.user_id, r.wallet_addr, r.challenge_amount,
         r.matched_moment_id, r.resolved_via
  FROM resolved r;
END;
$function$;

DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.resolve_wallet_verification_challenges()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_wallet_verification_challenges()', 'EXECUTE') THEN
    RAISE EXCEPTION 'resolve_wallet_verification_challenges became executable by anon/authenticated';
  END IF;
END $post$;
