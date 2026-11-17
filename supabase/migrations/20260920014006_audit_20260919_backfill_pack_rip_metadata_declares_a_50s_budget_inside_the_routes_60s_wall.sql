-- `backfill-pack-rip-metadata` (hourly :53 via cron-job.org → /api/cron/backfill-pack-rip-metadata →
-- PostgREST RPC as service_role) read 23/41 failing over 2 days on the pipeline alert board.
-- Re-derived 2026-09-19 6:45 PM PT: EVERY failure is `canceling statement due to statement timeout`
-- at 30.2 s — service_role's rolconfig `statement_timeout=30s` — and every one sits inside the two
-- IO spells (09-18 outage, 09-19 04:53→11:53 AM PT, eight consecutive). Since noon PT the lane is
-- 6/6 ok at 6.9–9.2 s, resolving 235–272 pull values per run. So the lane is not slow; its ceiling
-- is 4× its healthy duration, and any 4× spell kills every run for the spell's whole length,
-- writing nothing and leaving pack-rip metadata to go stale.
--
-- Lever: a function-level statement_timeout HIGHER than the role's applies under PostgREST
-- (CLAUDE.md, Database: "via PostgREST only a HIGHER one applies (gateway cap ~120 s)"). The route
-- runs the RPC inside after() under `maxDuration = 60`, and a maxDuration kill writes NO
-- pipeline_runs row (the wall-kill class), so the budget must stay under that wall with room for
-- log_pipeline_run: 50 s. That is ~7× the healthy duration — a spell up to ~7× now completes
-- instead of failing at 4×; a worse spell still fails visibly at 50 s with a terminal row.
--
-- Not changed: the function body (prosrc untouched, so no pin moves), the caller, the cadence.
-- ⚠ NOT a pg_cron budget — proconfig statement_timeout is INERT under pg_cron; this lane has no
-- pg_cron caller (checked cron.job.command for 'rip' + 'metadata': none).
--
-- Applied from Cowork cloud 2026-09-19 6:40 PM PT. ⚠ That session's push tooling is its own concern;
-- this file commits as usual.
--
-- EXIT: the next IO spell's :53 runs show durations between 30 and 50 s with ok=true, or the
-- pipeline alert's 2-day failure share falls under its `high` threshold without a spell.
-- FALSIFIER: a run that fails at exactly 30.x s after this applied ⇒ the proconfig did not bind
-- through PostgREST for this call shape, and the lane needs the pg_cron wrapper pattern (jobid 408).
-- REVERT: ALTER FUNCTION public.backfill_pack_rip_metadata(integer) RESET statement_timeout;

ALTER FUNCTION public.backfill_pack_rip_metadata(integer) SET statement_timeout = '50s';

DO $$
DECLARE v_cfg text[];
BEGIN
  SELECT proconfig INTO v_cfg FROM pg_proc WHERE proname = 'backfill_pack_rip_metadata' AND pronamespace = 'public'::regnamespace;
  IF NOT ('statement_timeout=50s' = ANY(v_cfg)) THEN RAISE EXCEPTION 'proconfig not applied: %', v_cfg; END IF;
  IF NOT ('search_path=public, pg_temp' = ANY(v_cfg)) THEN RAISE EXCEPTION 'search_path pin lost: %', v_cfg; END IF;
END $$;
