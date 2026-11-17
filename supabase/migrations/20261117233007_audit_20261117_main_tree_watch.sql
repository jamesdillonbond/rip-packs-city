-- 2026-11-17 (Claude Code, Trevor's laptop, ~3:30 PM PT; Trevor via Cowork: "a database-side watch that
-- alerts when main loses its files. Today's deletion sat for five hours, and a GitHub workflow can't catch it
-- because the deleting commit removes the workflow too.")
--
-- WHAT HAPPENED: `2e021e372` (1:16 AM PT) deleted 9,617 tracked files from `main`, `.github/` included; it was
-- noticed and restored at 6:22 AM PT. Every in-repo watcher is either a GitHub workflow (deleted by the same
-- commit) or code on the laptop tree (which fast-forwarded to the deletion at 5:15 AM and lost its scripts).
--
-- THE WATCH (lives entirely in the database, so neither can delete it):
--   pg_cron `rpc-main-tree-watch` every 10 min → rpc_main_tree_watch():
--     1. reads the PREVIOUS tick's pg_net responses for 7 sentinel files on raw.githubusercontent.com/…/main
--        (200 = present, 404 = MISSING, anything else = unreadable);
--     2. logs pipeline_runs 'main-tree-watch' (ok=false on missing OR unreadable — a watch that cannot read is
--        not a passing watch), with the per-file verdict in extra;
--     3. fires the next tick's 7 requests.
--   check_main_tree_missing() → get_pipeline_alerts(): the latest row (≤ 30 min old) with verdict 'missing'
--     raises a CRITICAL alert; three consecutive 'unreadable' rows raise HIGH. /api/check-alerts emails and
--     Telegrams critical/high and is driven OUTSIDE GitHub (it ran ~every 20 min all of 11-17 while every
--     GitHub schedule was dark).
--   pipeline_cadence_watchlist row: the watch itself going silent (pg_cron dead) pages via the cadence arm.
--
-- Sentinels: package.json, CLAUDE.md, app/layout.tsx, lib/supabase.ts, scripts/laptop-tree-ff.mjs,
-- .github/workflows/ci.yml, .github/workflows/pipeline-sentinel.yml — the app, the docs, the laptop guard and
-- the workflows each have one, so a partial deletion of any of those trees is seen too. Renaming a sentinel
-- file in the repo WILL page: update v_paths below in the same change.
--
-- Positive control (11-17 3:25 PM PT, by hand through pg_net): a real file 200, an absent file 404.
-- raw.githubusercontent.com serves through a CDN (~5 min), so detection lag is ≤ ~25 min.
--
-- anon-exec: revoked (rpc_main_tree_watch) — pg_cron only; REVOKE FROM PUBLIC, anon, authenticated below, GRANT to postgres/service_role.
-- anon-exec: revoked (check_main_tree_missing) — read only by get_pipeline_alerts (SECURITY DEFINER); REVOKE below.
-- anon-exec: unchanged (get_pipeline_alerts) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
--
-- Read back after apply (20261117233007): pg_cron job 893 (2-59/10); first real tick 3:30 PM PT read 21/21 present;
-- PLANTED-DEFECT CONTROL (rolled back): a fake sentinel pointed at a real 404 -> verdict missing -> a CRITICAL
-- main_tree_missing alert, returned by get_pipeline_alerts() itself; healthy state returns none. anon EXECUTE false on all
-- three functions; RLS on the request table; check_public_security_invariants() still [].
--
-- Revert:
--   SELECT cron.unschedule('rpc-main-tree-watch');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'main-tree-watch';
--   re-apply get_pipeline_alerts() as the three-arm form it was before this file (same header, body:
--     SELECT coalesce(public.get_pipeline_alerts_core(), '[]'::jsonb)
--         || coalesce(public.check_edge_fn_http_failures(interval '2 hours'), '[]'::jsonb)
--         || coalesce(public.check_pipelines_running_but_not_succeeding(), '[]'::jsonb);  ), then
--   DROP FUNCTION public.check_main_tree_missing(); DROP FUNCTION public.rpc_main_tree_watch();
--   DROP TABLE public.main_tree_watch_requests;

CREATE TABLE IF NOT EXISTS public.main_tree_watch_requests (
  request_id bigint PRIMARY KEY,
  path       text NOT NULL,
  fired_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.main_tree_watch_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.main_tree_watch_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.main_tree_watch_requests TO service_role;

CREATE OR REPLACE FUNCTION public.rpc_main_tree_watch()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_base    constant text := 'https://raw.githubusercontent.com/jamesdillonbond/rip-packs-city/main/';
  v_paths   constant text[] := ARRAY[
    'package.json', 'CLAUDE.md', 'app/layout.tsx', 'lib/supabase.ts', 'scripts/laptop-tree-ff.mjs',
    '.github/workflows/ci.yml', '.github/workflows/pipeline-sentinel.yml'
  ];
  v_files   jsonb;
  v_checked int;
  v_present int;
  v_missing int;
  v_missing_paths text[];
  v_verdict text;
  v_ok      boolean;
  v_error   text;
  v_path    text;
  v_id      bigint;
BEGIN
  -- 1. The previous tick's answers (fired ≥ 20 s ago, so pg_net has had time to land them).
  WITH batch AS (
    SELECT q.request_id, q.path, r.status_code, r.timed_out, r.error_msg, (r.id IS NOT NULL) AS answered
      FROM public.main_tree_watch_requests q
      LEFT JOIN net._http_response r ON r.id = q.request_id
     WHERE q.fired_at <= now() - interval '20 seconds'
  )
  SELECT count(*)::int,
         count(*) FILTER (WHERE status_code = 200)::int,
         count(*) FILTER (WHERE status_code = 404)::int,
         coalesce(array_agg(path ORDER BY path) FILTER (WHERE status_code = 404), '{}'),
         coalesce(jsonb_agg(jsonb_build_object(
           'path', path,
           'status', status_code,
           'state', CASE WHEN status_code = 200 THEN 'present'
                         WHEN status_code = 404 THEN 'MISSING'
                         WHEN NOT answered THEN 'no_response'
                         ELSE 'unreadable' END,
           'error', left(coalesce(error_msg, CASE WHEN timed_out THEN 'timed out' END), 120)
         ) ORDER BY path), '[]'::jsonb)
    INTO v_checked, v_present, v_missing, v_missing_paths, v_files
    FROM batch;

  IF v_checked = 0 THEN
    v_verdict := 'priming';            -- first tick: nothing fired yet, so nothing can be concluded
    v_ok := true;
  ELSIF v_missing > 0 THEN
    v_verdict := 'missing';
    v_ok := false;
    v_error := format('main is MISSING %s of %s sentinel files: %s — a commit on main deleted tracked files (11-17: 2e021e372 deleted 9,617). Restore main, then check the laptop tree (laptop-tree-ff refuses a mass deletion).',
                      v_missing, v_checked, array_to_string(v_missing_paths, ', '));
  ELSIF v_present = v_checked THEN
    v_verdict := 'present';
    v_ok := true;
  ELSE
    v_verdict := 'unreadable';
    v_ok := false;
    v_error := format('could not read %s of %s sentinel files from raw.githubusercontent.com (no 200/404) — the watch is blind this tick, not passing',
                      v_checked - v_present, v_checked);
  END IF;

  DELETE FROM public.main_tree_watch_requests WHERE fired_at <= now() - interval '20 seconds';

  -- 2. Fire the next tick's requests.
  FOREACH v_path IN ARRAY v_paths LOOP
    v_id := net.http_get(url := v_base || v_path, timeout_milliseconds := 15000);
    INSERT INTO public.main_tree_watch_requests (request_id, path) VALUES (v_id, v_path);
  END LOOP;

  PERFORM public.log_pipeline_run(
    p_pipeline        := 'main-tree-watch',
    p_started_at      := now(),
    p_rows_found      := v_checked,
    p_rows_written    := NULL::int,
    p_rows_skipped    := NULL::int,
    p_ok              := v_ok,
    p_error           := v_error,
    p_collection_slug := NULL::text,
    p_cursor_before   := NULL::text,
    p_cursor_after    := NULL::text,
    p_extra           := jsonb_build_object('source', 'pg_cron', 'verdict', v_verdict, 'checked', v_checked,
                                            'present', v_present, 'missing', v_missing, 'files', v_files,
                                            'next_fired', array_length(v_paths, 1))
  );

  RETURN jsonb_build_object('verdict', v_verdict, 'ok', v_ok, 'checked', v_checked, 'missing', v_missing_paths);
END
$fn$;

REVOKE ALL ON FUNCTION public.rpc_main_tree_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_main_tree_watch() TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.check_main_tree_missing()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
  WITH recent AS (
    SELECT pr.started_at, pr.extra->>'verdict' AS verdict, pr.error,
           row_number() OVER (ORDER BY pr.started_at DESC) AS rn
      FROM public.pipeline_runs pr
     WHERE pr.pipeline = 'main-tree-watch'
       AND pr.started_at > now() - interval '45 minutes'
  )
  SELECT coalesce(jsonb_agg(a), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('severity', 'critical', 'type', 'main_tree_missing', 'pipeline', 'main-tree-watch',
                              'detail', error) AS a
      FROM recent
     WHERE rn = 1 AND verdict = 'missing' AND started_at > now() - interval '30 minutes'
    UNION ALL
    SELECT jsonb_build_object('severity', 'high', 'type', 'main_tree_watch_blind', 'pipeline', 'main-tree-watch',
                              'detail', 'the main-tree watch could not read raw.githubusercontent.com on its last 3 ticks — a deletion of main would go unseen until it can')
     WHERE (SELECT count(*) FROM recent WHERE rn <= 3 AND verdict = 'unreadable') = 3
  ) s;
$fn$;

REVOKE ALL ON FUNCTION public.check_main_tree_missing() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_main_tree_missing() TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.get_pipeline_alerts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  SELECT coalesce(public.get_pipeline_alerts_core(), '[]'::jsonb)
      || coalesce(public.check_edge_fn_http_failures(interval '2 hours'), '[]'::jsonb)
      || coalesce(public.check_pipelines_running_but_not_succeeding(), '[]'::jsonb)
      || coalesce(public.check_main_tree_missing(), '[]'::jsonb);
$function$;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, severity, max_silent_minutes, is_active, notes)
VALUES (
  'main-tree-watch',
  'high',
  45,
  true,
  'pg_cron rpc-main-tree-watch (every 10 min). Reads 7 sentinel files on main via raw.githubusercontent.com and pages CRITICAL through check_main_tree_missing() if any 404s. Added 2026-11-17 after 2e021e372 deleted 9,617 files from main (incl. .github/) and sat 5 h unseen. This row pages if the watch itself stops.'
)
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule(
  'rpc-main-tree-watch',
  '2-59/10 * * * *',
  $cron$SET statement_timeout = '30s'; SELECT public.rpc_main_tree_watch();$cron$
);
