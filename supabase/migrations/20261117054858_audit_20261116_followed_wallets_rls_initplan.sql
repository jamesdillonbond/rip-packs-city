-- audit_20261116_followed_wallets_rls_initplan
--
-- 2026-11-16 ~9:49 PM PT (Claude Code cloud, autonomous pass). Supabase performance advisor
-- auth_rls_initplan (WARN): the three followed_wallets policies (20261117024128, shipped this evening)
-- called auth.uid() per row. Wrapped in a scalar sub-select so it is evaluated once per statement —
-- the form every other RLS policy in this project already uses (these were the only three flagged).
-- Same predicate, same roles, same commands; no data change.
-- Revert: ALTER POLICY <name> ON public.followed_wallets USING / WITH CHECK (follower_user_id = auth.uid())
--         for each of the three.

ALTER POLICY followed_wallets_select_own ON public.followed_wallets USING (follower_user_id = (select auth.uid()));
ALTER POLICY followed_wallets_insert_own ON public.followed_wallets WITH CHECK (follower_user_id = (select auth.uid()));
ALTER POLICY followed_wallets_delete_own ON public.followed_wallets USING (follower_user_id = (select auth.uid()));
