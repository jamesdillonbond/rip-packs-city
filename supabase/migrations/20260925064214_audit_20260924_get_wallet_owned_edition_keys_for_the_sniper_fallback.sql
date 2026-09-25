-- 2026-09-24 (PT) — /api/owned-flow-ids derives a wallet's owned Top Shot
-- edition keys (setID:playID) with an on-chain per-moment Cadence script that
-- dies at Flow's 100,000 computation limit on a large collection ("[Error
-- Code: 1110] computation limit exceeded" — 4 times in 90 minutes on the
-- founder's 15,527-moment wallet). The route then answered 200 with
-- editions: [] under max-age=600, and the sniper cached "owns nothing" for ten
-- minutes: every Own marker gone for exactly the collectors with the most to
-- match. This function is the DEPTH fallback (same subject, last synced
-- snapshot instead of the chain): the wallet's distinct set:play keys from
-- wallet_moments_cache, a subedition suffix ("::4") stripped so the keys match
-- the on-chain shape. Non-Top-Shot collections have no such key and get [].
-- Revert: DROP FUNCTION public.get_wallet_owned_edition_keys(text, uuid).
-- anon-exec: intentional — REVOKEd from PUBLIC, anon and authenticated; the route reads it with the service role.
CREATE OR REPLACE FUNCTION public.get_wallet_owned_edition_keys(p_wallet text, p_collection_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '8s'
AS $$
  SELECT COALESCE(array_agg(DISTINCT split_part(w.edition_key, '::', 1)), '{}'::text[])
  FROM public.wallet_moments_cache w
  WHERE w.wallet_address = lower(p_wallet)
    AND w.collection_id = p_collection_id
    AND w.edition_key IS NOT NULL
    AND split_part(w.edition_key, '::', 1) ~ '^[0-9]+:[0-9]+$';
$$;
REVOKE EXECUTE ON FUNCTION public.get_wallet_owned_edition_keys(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_wallet_owned_edition_keys(text, uuid) TO service_role, postgres;

DO $$
DECLARE n int;
BEGIN
  SELECT cardinality(public.get_wallet_owned_edition_keys('0xbd94cade097e50ac', '95f28a17-224a-4025-96ad-adf8a4c63bfd')) INTO n;
  IF n < 1000 THEN RAISE EXCEPTION 'expected thousands of keys on the founder wallet, got %', n; END IF;
END $$;
