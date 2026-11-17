-- audit_20261026: the All Day first-mint views read as their caller (service_role), not as their owner.
-- 20261027051708 created them without a security mode; its repo file now carries WITH (security_invoker = on).
-- service_role holds SELECT on mv_allday_first_mint_trophies, so the route's read is unchanged (27 rows, re-read 10-26 ~10:40 PM PT).
-- Revert: ALTER VIEW public.allday_first_mint_trophies RESET (security_invoker);
--         ALTER VIEW public.allday_first_mint_trophy_stats RESET (security_invoker);
ALTER VIEW public.allday_first_mint_trophies SET (security_invoker = on);
ALTER VIEW public.allday_first_mint_trophy_stats SET (security_invoker = on);
