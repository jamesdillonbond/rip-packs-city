-- audit_20260727_rls_initplan_wrap_auth_uid
-- Performance advisor `auth_rls_initplan`: 4 own-row SELECT policies re-evaluated
-- auth.uid() PER ROW. Wrap in (select auth.uid()) so the planner evaluates it once
-- as an initplan constant. Behavior-identical (user_id = same uid); roles/cmd/
-- permissive unchanged. Applied live via Supabase MCP on 2026-07-27.
-- Revert: ALTER POLICY <name> ON <table> USING (user_id = auth.uid()); for each.
ALTER POLICY ledger_own    ON public.points_ledger  USING (user_id = (select auth.uid()));
ALTER POLICY raffle_own    ON public.raffle_entries USING (user_id = (select auth.uid()));
ALTER POLICY redeem_own    ON public.redemptions    USING (user_id = (select auth.uid()));
ALTER POLICY cosmetics_own ON public.user_cosmetics USING (user_id = (select auth.uid()));
