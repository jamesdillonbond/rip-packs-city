-- `match-topshot-players` (edge fn, cron-job.org daily 08:00Z) calls `match_topshot_players_run()`
-- via PostgREST. The function gates itself: inputs unchanged AND last full run < 7 days → a cheap
-- `gated: true`; otherwise the FULL run (temp tables over wallet_moments_cache player names +
-- trigram similarity against nba_players). The full run took 12.9 s on a quiet box (hand-dispatched
-- 2026-09-19 6:45 PM PT) — but on 09-19 08:00Z it met the morning IO spell and DIED AT 125 s =
-- THE POSTGREST GATEWAY (`upstream request timeout`): its proconfig `statement_timeout=300s`
-- cannot bind past the ~120 s gateway, so the weekly full run had exactly one chance a week and it
-- was in whatever state the box happened to be in. The sentinel's `Pipeline Success Coverage`
-- arm then read `match-topshot-players 0/1 ok` for the day.
--
-- This migration gives the FULL run a pg_cron home BEFORE the edge tick: daily 07:32Z (12:32 AM
-- PT; measured the quietest 07Z minute over 7 days — 75 busy-seconds, vs 116–229 for the rest,
-- excluding the banned :40/:41) as postgres with a `SET statement_timeout = '300s'` prefix (the
-- jobid 4 precedent: the prefix binds the budget the proconfig cannot under pg_cron; a plain
-- SELECT tolerates the transaction block). The wrapper writes the SAME terminal `pipeline_runs`
-- row shape the edge function writes (pipeline `match-topshot-players`, collection nba-top-shot,
-- rows_found = skipped + total_unresolved, rows_written = auto_aliased, extra.gated / gate_reason /
-- last_full_run_at / summary / needs_manual_review) plus `extra.via = 'pg_cron'`, so the two
-- callers stay distinguishable and the arm reads the day honestly.
--
-- Effect on the edge tick: unchanged in code. When the 07:32Z run did the full pass, the 08:00Z
-- tick finds `last_full_run_at` 28 minutes old and gates (`ok`, `gated: true`). When inputs change
-- between the two (a player sync landing in that window) the edge tick still attempts the full
-- run exactly as today — no regression, just one extra chance a day that never meets the gateway.
-- The function is NOT changed; its 7-day gate means this job does a full pass at most weekly plus
-- whenever nba_players/nba_player_aliases change.
--
-- Applied from Cowork cloud 2026-09-19 7:26 PM PT (jobid 543). ⚠ That session's push tooling is
-- its own concern; this file commits as usual.
--
-- EXIT: the 12:32 AM PT tick writes a `match-topshot-players` row with extra.via = 'pg_cron' (gated
-- or full, ok = true); the 08:00Z edge tick that follows logs `gated: true`.
-- FALSIFIER: a pg_cron full run killed at 300 s on a quiet box (io_wait < 3) ⇒ the run's own cost
-- moved (trigram similarity over a larger nba_players), not the estate.
-- REVERT: SELECT cron.unschedule('rpc-match-topshot-players-full');
--         DROP FUNCTION public.run_match_topshot_players_full_job();
--
-- anon-exec: intentional — REVOKEd from PUBLIC, anon, authenticated below; only pg_cron as
-- postgres calls it (run_match_topshot_players_full_job)

CREATE OR REPLACE FUNCTION public.run_match_topshot_players_full_job()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_res     jsonb;
  v_ok      boolean := true;
  v_err     text := NULL;
  v_gated   boolean;
  v_skipped integer;
  v_auto    integer;
  v_unres   integer;
  v_review  jsonb;
BEGIN
  BEGIN
    v_res := public.match_topshot_players_run();
  EXCEPTION WHEN OTHERS THEN
    -- includes 57014 query_canceled at the 300 s prefix budget: the temp tables and any alias
    -- inserts roll back, the row below still lands, and the counts stay NULL (unmeasured, not zero).
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;

  v_gated   := coalesce((v_res->>'gated')::boolean, false);
  v_skipped := (v_res->>'skipped')::integer;
  v_auto    := (v_res->>'auto_aliased')::integer;
  v_unres   := (v_res->>'total_unresolved')::integer;
  v_review  := coalesce(v_res->'needs_review', '[]'::jsonb);

  PERFORM public.log_pipeline_run(
    'match-topshot-players',
    v_started,
    CASE WHEN v_ok THEN coalesce(v_skipped, 0) + coalesce(v_unres, 0) END,
    CASE WHEN v_ok THEN coalesce(v_auto, 0) END,
    CASE WHEN v_ok THEN coalesce(v_skipped, 0) END,
    v_ok,
    v_err,
    'nba-top-shot',
    NULL,
    NULL,
    jsonb_build_object(
      'via', 'pg_cron',
      'jobname', 'rpc-match-topshot-players-full',
      'gated', v_gated,
      'gate_reason', CASE WHEN v_gated THEN coalesce(v_res->>'gate_reason', 'inputs unchanged') END,
      'last_full_run_at', v_res->'last_full_run_at',
      'summary', jsonb_build_object(
        'skipped', v_skipped,
        'auto_aliased', v_auto,
        'total_unresolved', v_unres,
        'needs_review_count', jsonb_array_length(v_review)),
      'needs_manual_review', (SELECT coalesce(jsonb_agg(e), '[]'::jsonb)
                                FROM (SELECT e FROM jsonb_array_elements(v_review) e LIMIT 200) s),
      'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN coalesce(v_res, jsonb_build_object('ok', false, 'error', v_err));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.run_match_topshot_players_full_job() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.run_match_topshot_players_full_job() IS
  'pg_cron rpc-match-topshot-players-full (32 7 UTC = 12:32 AM PT, postgres, 300 s prefix budget) wrapper: runs match_topshot_players_run() with no PostgREST gateway and writes the edge function''s exact terminal pipeline_runs row under match-topshot-players with extra.via = pg_cron. Added 2026-09-19 after the weekly full run died at the 125 s gateway inside an IO spell; the 08:00Z edge tick stays as the gated daily check.';

SELECT cron.schedule(
  'rpc-match-topshot-players-full',
  '32 7 * * *',
  $cmd$SET statement_timeout = '300s'; SELECT public.run_match_topshot_players_full_job();$cmd$
);

DO $$
DECLARE v_id int; v_cmd text; v_user text; v_sched text;
BEGIN
  SELECT jobid, command, username, schedule INTO v_id, v_cmd, v_user, v_sched
    FROM cron.job WHERE jobname = 'rpc-match-topshot-players-full';
  IF v_id IS NULL THEN RAISE EXCEPTION 'job not scheduled'; END IF;
  IF v_user <> 'postgres' THEN RAISE EXCEPTION 'owner: %', v_user; END IF;
  IF v_sched <> '32 7 * * *' THEN RAISE EXCEPTION 'schedule: %', v_sched; END IF;
  IF strpos(v_cmd, 'run_match_topshot_players_full_job') = 0 OR strpos(v_cmd, 'statement_timeout = ''300s''') = 0 THEN
    RAISE EXCEPTION 'command not applied: %', v_cmd;
  END IF;
  IF has_function_privilege('anon', 'public.run_match_topshot_players_full_job()', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked'; END IF;
  IF has_function_privilege('authenticated', 'public.run_match_topshot_players_full_job()', 'EXECUTE') THEN RAISE EXCEPTION 'authenticated EXECUTE leaked'; END IF;
END $$;
