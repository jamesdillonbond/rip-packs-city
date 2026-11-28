-- audit_20261128_lock_check_batch_custom_plans
--
-- WHAT. get_lock_check_batch(text, integer, integer) gains `SET plan_cache_mode = force_custom_plan`. The body is
-- untouched (still the 20260929235000 definition, md5 7f0dfdc593561f25b4c25c4c57bc0350), so it returns the same rows.
--
-- WHY. The lock-check lane's candidate picker was the #1 non-cron PostgREST reader in pg_stat_statements (24 h to
-- 11-28 8:05 AM PT: 93 calls, 33.7 s and 39,037 blocks read per call) — against the 85–160 ms / ~17,855 buffers its
-- route header recorded on 09-28. A SQL function with SET clauses is not inlined, so it runs on a plan built with its
-- arguments as unknown parameters; under a generic plan `(p_collection_slug IS NULL OR c.slug = p_collection_slug)`
-- reads as "every collection" and the plan is shaped for that. Measured 2026-11-28 ~9:05 AM PT, same body:
--     disney_pinnacle, 1000, 7   as live: 26,396 ms (36,218 read)   inlined with literals: 1,085 ms
--                                force_custom_plan copy:  652 ms (2,524 read)
--     nba_top_shot,    1000, 7   as live: 56,292 ms (187,142 buffers) force_custom_plan copy: 32,789 ms (126,755)
-- The route calls it once per collection per tick (LOCK_CHECK_SLUGS = nba_top_shot, disney_pinnacle): ~82 s -> ~33 s.
-- The remaining Top Shot cost is inherent to the design (298 hot wallets x up to p_limit rows each in the priority
-- leg), not the plan — not changed here.
-- A body rewrite splitting `IS NULL OR < cutoff` into two index ranges was tried first and measured WORSE / no better
-- (Pinnacle 35 s, Top Shot > 58 s): the plan, not the predicate, was the cost.
--
-- anon-exec: unchanged (get_lock_check_batch) — ALTER FUNCTION … SET only; no signature, body or grant change.
--
-- REVERT: ALTER FUNCTION public.get_lock_check_batch(text, integer, integer) RESET plan_cache_mode;

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_lock_check_batch(text,integer,integer)'::regprocedure)
       IS DISTINCT FROM '7f0dfdc593561f25b4c25c4c57bc0350' THEN
    RAISE EXCEPTION 'get_lock_check_batch body changed since 20260929235000 — re-measure before applying';
  END IF;
END $$;

ALTER FUNCTION public.get_lock_check_batch(text, integer, integer) SET plan_cache_mode = force_custom_plan;
