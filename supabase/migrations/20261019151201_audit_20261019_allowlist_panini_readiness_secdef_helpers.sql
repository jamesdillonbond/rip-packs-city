-- audit_20261019_allowlist_panini_readiness_secdef_helpers
--
-- The two SECDEF helpers behind the /api/ready Panini row (20261019151025,
-- 20261019151137) are anon-executable by design; record why in the allowlist so
-- check_secdef_anon_execute_violations() reads [] (verified after apply).
-- Revert: DELETE the two rows by identity.

INSERT INTO public.secdef_anon_exec_allowlist (identity, note) VALUES
 ('panini_newest_recorded_sale_at()', 'Returns ONE timestamptz (newest recorded Panini sale, 7 d) and no rows or usernames. Called by readiness_collection_stats (SECURITY INVOKER) for the anon-reachable /api/ready, because anon has no SELECT on panini_sales. 2026-10-19, #64 readiness arm.'),
 ('panini_readiness_row()', 'Returns ONE jsonb row {slug,name,sales_24h:null,thin_volume:null,last_sale_at} for Panini. Needed because anon RLS on collections hides is_active=false rows. Called by readiness_collection_stats for /api/ready. 2026-10-19, #64 readiness arm.')
ON CONFLICT DO NOTHING;
