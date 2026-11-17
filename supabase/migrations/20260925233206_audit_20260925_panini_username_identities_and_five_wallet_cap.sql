-- audit_20260925_panini_username_identities_and_five_wallet_cap
--
-- Trevor 2026-09-25: "We should allow 5 wallets per user." Plus: let a signed-in collector link a
-- Panini username to their profile, the way a Flow/Candy wallet is saved.
--
-- (1) FREE-PLAN CAP 1 -> 5. feature_quotas.saved_wallets_max for plan 'free' was 1, and all 27
--     users already held a Flow wallet, so saving a Candy wallet (a second distinct address)
--     returned 402 plan_limit_reached for every free user: `saved_wallets` held 0 Candy rows.
--     pro_trial is already 5; every paid/founding/admin plan stays unlimited (NULL).
--     The cap counts DISTINCT wallets PLUS linked usernames (lib/profile/saved-wallet-quota.ts).
--
-- (2) saved_collector_identities. A Panini owner is a USERNAME, not an address:
--     panini_card_serials.owner is never EVM-shaped (lib/address.ts). Storing it in
--     saved_wallets.wallet_addr would hand a username to every chain-aware wallet helper, so it
--     gets its own table. identity_value is stored LOWERCASED: 71% of owner rows are mixed case,
--     every read matches on lower(owner). RLS on, no client grants: only the service-role route
--     /api/profile/collector-identities (requireUser-gated) reads or writes it.
--
-- (3) panini_owner_summary(text). What RPC can say about a username: cards SEEN under it in
--     panini_card_serials. That table is LISTING-fed (7,721 of 7,731 rows for one top owner are
--     is_listed), so this is "cards seen on Panini's marketplace", NOT holdings; the route and UI
--     say so. owner = '' (31,405 rows) is excluded: an empty owner is not a collector.
--     Backed by idx_panini_serials_owner_lower, BUILT CONCURRENTLY via execute_sql minutes before
--     this migration (1776 kB, indisvalid = true); the CREATE INDEX IF NOT EXISTS below is a
--     production no-op so the object is not fileless.
--
-- anon-exec: revoked (panini_owner_summary) — new function; REVOKE FROM PUBLIC, anon, authenticated below, service_role only.
--
-- REVERT:
--   UPDATE public.feature_quotas SET daily_limit = 1 WHERE plan = 'free' AND feature_name = 'saved_wallets_max';
--   DROP FUNCTION IF EXISTS public.panini_owner_summary(text);
--   DROP TABLE IF EXISTS public.saved_collector_identities;
--   (index is harmless to keep; to drop: DROP INDEX CONCURRENTLY IF EXISTS public.idx_panini_serials_owner_lower;)

UPDATE public.feature_quotas
   SET daily_limit = 5, updated_at = now(),
       notes = 'Max saved wallets + linked usernames at any time (raised 1 -> 5, 2026-09-25)'
 WHERE plan = 'free' AND feature_name = 'saved_wallets_max';

CREATE INDEX IF NOT EXISTS idx_panini_serials_owner_lower
  ON public.panini_card_serials (lower(owner)) WHERE owner <> '';

CREATE TABLE IF NOT EXISTS public.saved_collector_identities (
  id             bigserial PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  collection_id  uuid NOT NULL REFERENCES public.collections(id),
  identity_kind  text NOT NULL CHECK (identity_kind IN ('username')),
  identity_value text NOT NULL CHECK (identity_value = lower(identity_value) AND length(identity_value) BETWEEN 2 AND 64),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, collection_id, identity_kind, identity_value)
);
CREATE INDEX IF NOT EXISTS idx_saved_collector_identities_user ON public.saved_collector_identities (user_id);
ALTER TABLE public.saved_collector_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.saved_collector_identities FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.saved_collector_identities TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.saved_collector_identities_id_seq TO service_role;
COMMENT ON TABLE public.saved_collector_identities IS
  'Non-address collector identities a user links to their profile (today: Panini usernames, stored lowercased). Addresses live in saved_wallets. Service-role only; written by /api/profile/collector-identities.';

CREATE OR REPLACE FUNCTION public.panini_owner_summary(p_username text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'username',        lower(p_username),
    'cards_seen',      count(*),
    'listed_now',      count(*) FILTER (WHERE is_listed),
    'special_serials', count(*) FILTER (WHERE is_special),
    'editions',        count(DISTINCT edition_external_id),
    'last_seen_at',    max(captured_at)
  )
  FROM public.panini_card_serials
  WHERE owner <> '' AND lower(owner) = lower(p_username);
$$;
REVOKE EXECUTE ON FUNCTION public.panini_owner_summary(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_owner_summary(text) TO service_role;
COMMENT ON FUNCTION public.panini_owner_summary(text) IS
  'Cards SEEN under a Panini username in panini_card_serials (listing-fed, so NOT full holdings). cards_seen = 0 means RPC has never seen that username.';
