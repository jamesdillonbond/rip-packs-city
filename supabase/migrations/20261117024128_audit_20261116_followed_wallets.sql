-- audit_20261116_followed_wallets
--
-- Follow a WALLET, not only an RPC member (Trevor, 2026-11-16: "do it all" on the
-- save-vs-friend mix-up). Until now the only way to keep a friend's collection
-- handy was to SAVE it — the path that makes a wallet "mine" (binder, FMV totals,
-- public /profile/<handle> claim). `follows` is member-to-member and had 0 rows:
-- a friend who never signed up could not be followed at all.
--
-- One row = "this user watches this wallet". Read by /api/profile/activity
-- (Friend Activity) and written by /api/profile/followed-wallets. Routes use the
-- service role; the own-row policies are there so a direct authenticated client
-- can never see or write another user's follows.
--
-- wallet_addr is stored normalised (lib/address.ts normalizeAddress: hex folded,
-- base58 verbatim) — never lower() it here, a Candy key is case-sensitive.
--
-- Revert: DROP TABLE public.followed_wallets;

CREATE TABLE IF NOT EXISTS public.followed_wallets (
  follower_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_addr      text NOT NULL CHECK (length(wallet_addr) BETWEEN 18 AND 64),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_user_id, wallet_addr)
);

ALTER TABLE public.followed_wallets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.followed_wallets FROM PUBLIC, anon;
GRANT SELECT, INSERT, DELETE ON TABLE public.followed_wallets TO authenticated;
GRANT ALL ON TABLE public.followed_wallets TO service_role;

CREATE POLICY followed_wallets_select_own ON public.followed_wallets
  FOR SELECT TO authenticated USING (follower_user_id = auth.uid());
CREATE POLICY followed_wallets_insert_own ON public.followed_wallets
  FOR INSERT TO authenticated WITH CHECK (follower_user_id = auth.uid());
CREATE POLICY followed_wallets_delete_own ON public.followed_wallets
  FOR DELETE TO authenticated USING (follower_user_id = auth.uid());

COMMENT ON TABLE public.followed_wallets IS
  'Wallets a user follows (friend activity) without saving them as their own. Written by /api/profile/followed-wallets, read by /api/profile/activity. 2026-11-16.';
