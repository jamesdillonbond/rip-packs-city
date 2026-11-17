-- audit_20261018 — wallet verification's on-chain leg dates storefront_v2 listings by ingested_at.
--
-- Follow-up to 20261018232027_audit_20261018_wallet_verification_matches_the_onchain_book
-- (same session, minutes later). Its "listed after the challenge" rule read
-- listed_at, which is NULL on every storefront_v2 row (8,646 open on 2026-10-18 —
-- the state-based reconcile lane records no listing event), so those listings
-- could never verify a wallet. Found by the rolled-back production probe, which
-- picked a storefront_v2 row and hit the NULL. Now COALESCE(listed_at,
-- ingested_at): ingested_at is when the reconcile first saw the listing.
-- Nothing else changes. Built from live md5(prosrc) ee5e6b24ef37f6426062951c1f5e33a8.
-- anon-exec: unchanged (resolve_wallet_verification_challenges) — CREATE OR REPLACE of an existing fn; ACL preserved (service_role only), checked below.
--
-- REVERT: re-apply the previous migration's body (listed_at only).

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'resolve_wallet_verification_challenges' AND pronamespace = 'public'::regnamespace) <> 'ee5e6b24ef37f6426062951c1f5e33a8' THEN
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
      SELECT c2.flow_id, c2.source, COALESCE(c2.listed_at, c2.ingested_at) AS listed_at
        FROM cached_listings_v2 c2
       WHERE c2.completed_at IS NULL
         AND LOWER(c2.seller_address) = LOWER(wvc.wallet_addr)
         AND c2.price_usd = wvc.challenge_amount
         -- storefront_v2 rows (the state-based reconcile) carry no listed_at;
         -- ingested_at is when the reconcile first saw the listing.
         AND COALESCE(c2.listed_at, c2.ingested_at) >= wvc.created_at
         AND (c2.expiry_at IS NULL OR c2.expiry_at > v_now)
       ORDER BY COALESCE(c2.listed_at, c2.ingested_at) DESC
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
