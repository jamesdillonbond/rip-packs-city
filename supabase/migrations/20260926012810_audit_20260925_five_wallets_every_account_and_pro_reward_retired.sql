-- audit_20260925_five_wallets_every_account_and_pro_reward_retired
--
-- Trevor 2026-09-25: "5 wallets for any account. Assume I always mean free accounts. We shouldn't
-- be considering or mentioning paid accounts anywhere on the website ... until we get to 100
-- weekly active users."
--
-- (1) saved_wallets_max = 5 for EVERY plan (was 5 free/pro_trial, NULL = unlimited for
--     pro_paid/pro_grandfather/moments_payment/founding/admin). The three save routes no longer
--     read this row at all (lib/profile/saved-wallet-quota.ts SAVED_WALLET_LIMIT); this keeps the
--     table from saying something different to any future reader.
-- (2) The `pro_1mo` rewards shop item ("1 Month of RPC Pro") is deactivated, so a Rewards
--     re-enable cannot surface a paid tier. /rewards is notFound() today, so nothing visible moves.
--
-- Untouched on purpose: pro_users (21 rows) and every other feature_quotas row (e.g. concierge
-- limits) — no visible surface names a plan after this change, and removing grants from existing
-- members is not what was asked.
--
-- anon-exec: not applicable — this migration creates no function.
--
-- REVERT:
--   UPDATE public.feature_quotas SET daily_limit = NULL
--    WHERE feature_name = 'saved_wallets_max'
--      AND plan IN ('pro_paid','pro_grandfather','moments_payment','founding','admin');
--   UPDATE public.shop_items SET active = true, updated_at = now() WHERE sku = 'pro_1mo';

UPDATE public.feature_quotas
   SET daily_limit = 5, updated_at = now(),
       notes = 'Max saved wallets + linked usernames — 5 for every account (2026-09-25)'
 WHERE feature_name = 'saved_wallets_max';

UPDATE public.shop_items
   SET active = false, updated_at = now()
 WHERE sku = 'pro_1mo';
