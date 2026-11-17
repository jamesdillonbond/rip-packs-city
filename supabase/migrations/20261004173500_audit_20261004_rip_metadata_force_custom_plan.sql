-- 2026-10-04 (PT) — backfill_pack_rip_metadata: always plan with the call's real values.
--
-- WHY. The hourly `backfill-pack-rip-metadata` run logs ~36 s (and timed out at 50 s on 5 of 24
-- runs), yet the same call in a fresh session takes 11.3 s (rolled-back DO block, batch 2000).
-- The difference is the PLAN CACHE: PostgREST keeps its connections, and after five executions
-- plpgsql may switch a statement to a GENERIC plan, one that ignores the v_* share variables
-- driving every LIMIT. Forced generic in the same rolled-back DO block: 30.1 s, vs 11.3 s custom.
-- That is the production number.
--
-- WHAT. `SET plan_cache_mode = force_custom_plan` on the function, so each call plans with its
-- real values. The body (prosrc) is unchanged, so its pins still hold; only proconfig gains one
-- setting. A function-level SET overrides the session's mode for the duration of the call.
--
-- Verified after apply in the rolled-back DO block, with the SESSION forced generic: see the
-- ledger entry of 2026-10-04.
--
-- REVERT: ALTER FUNCTION public.backfill_pack_rip_metadata(integer) RESET plan_cache_mode;

ALTER FUNCTION public.backfill_pack_rip_metadata(integer) SET plan_cache_mode TO 'force_custom_plan';
