-- 2026-11-15 (PT) — daytime monitor 11-15 16:04Z candidate 2: hybrid-custody-backfill
-- failed 2 of 5 runs in 3 days with `get_hybrid_custody_candidates: canceling statement
-- due to statement timeout`. pgss: 30 calls, mean 9.1 s, max 24.2 s, ~18.7k disk reads
-- per call. Measured 8:3x AM PT: the 90-day buyer/seller scan over analytics_sales is
-- purely cold IO — first leg 26k disk reads / 8.5 s, the identical second leg warm in
-- 0.27 s — so under estate IO it crosses service_role's 30 s statement_timeout.
-- Change: a function-level statement_timeout of 90 s (via PostgREST a HIGHER per-function
-- timeout applies; the gateway cap is ~120 s). Body unchanged.
-- Revert: ALTER FUNCTION public.get_hybrid_custody_candidates(integer) RESET statement_timeout;
ALTER FUNCTION public.get_hybrid_custody_candidates(integer) SET statement_timeout = '90s';
