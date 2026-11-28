-- audit_20261128_nba_espn_drain_boxscore_404_is_not_a_run_failure
--
-- WHAT. nba_espn_drain(): an ESPN box-score (`summary?event=<id>`) that answers HTTP 404 is recorded as
-- `{"ok": false, "not_found": true, "status": 404}` on its nba_espn_requests row and counted in a new
-- `boxscore_not_found` stat — NOT as a run error. Every other failure (5xx, timeout, no response, a 200
-- without two boxscore teams, any other kind's error) still fails the run exactly as before. One guard keeps
-- a real outage visible: a run that saw ≥ 3 box-score 404s and landed NO box score still fails
-- (`every_boxscore_404 (n)`), because that is a changed URL or a blocked host, not missing games.
--
-- WHY. 2026-11-27 9:06 PM PT the run went ok=false on three 404s while it wrote 1,041 box-score rows across
-- 36 games (inbox 2026-11-28T0713Z). The three were playoff games 401871334 / 401871337 / 401873343
-- (CLE@DET 05-08 and 05-14, NY@CLE 05-24): `status = 'final'` with NO scores — "if necessary" games that were
-- never played, so ESPN's 404 is the correct answer. They came from the launch backfill, but the live
-- dispatcher re-asks any game of the last 3 days with no stats every 55 min, so one postponed or removed
-- game would have failed a run every hour for 3 days under `v_ok := v_errs = 0`.
--
-- HOW. md5-asserted splice of the LIVE body (prosrc 69b3cd9df6dfd2479b8eb6cf835157cb, read 2026-11-28
-- ~8:00 AM PT). The committed 20261128050912 copy does NOT match live (md5 0015260d…), so the body is edited
-- in place rather than re-declared from that file; each target string is asserted to occur exactly as often
-- as expected. No test pins this function. Header (plpgsql, volatile, invoker, search_path pg_catalog, public)
-- and grants (service_role, postgres) are carried over by ALTER-free CREATE OR REPLACE with the same header.
--
-- anon-exec: unchanged (nba_espn_drain) — CREATE OR REPLACE, same signature; EXECUTE was service_role + postgres only and is preserved.
--
-- REVERT: re-run this block with the replacements inverted, or restore the body archived by this migration:
--   flowty_archive.audit_20261128_nba_espn_drain_body (one row: the pre-splice prosrc).

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261128_nba_espn_drain_body (
  fn text PRIMARY KEY, prosrc text NOT NULL, md5 text NOT NULL, archived_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON flowty_archive.audit_20261128_nba_espn_drain_body FROM PUBLIC, anon, authenticated;

DO $do$
DECLARE
  v_src text;
  v_new text;
  v_n   int;

  -- each pair: target, replacement, expected occurrences
  t1 text := '  v_box_rows  int := 0;';
  r1 text := '  v_box_rows  int := 0;' || E'\n' || '  v_box_missing int := 0;  -- 2026-11-28: box scores ESPN answered 404 (never-played / removed games)';

  t2 text := '      if q.status_code is null or q.status_code <> 200 or q.timed_out then';
  r2 text := '      -- 2026-11-28: a box score ESPN answers 404 is a game with no box score (an unplayed "if necessary"'
          || E'\n' || '      -- playoff game, a removed id) — recorded as not_found, not a run error. Anything else still raises.'
          || E'\n' || '      if q.kind = ''boxscore'' and q.status_code = 404 and not coalesce(q.timed_out, false) then'
          || E'\n' || '        update public.nba_espn_requests'
          || E'\n' || '           set drained_at = now(), outcome = jsonb_build_object(''ok'', false, ''not_found'', true, ''status'', 404)'
          || E'\n' || '         where request_id = q.request_id;'
          || E'\n' || '        v_box_missing := v_box_missing + 1;'
          || E'\n' || '        continue;'
          || E'\n' || '      end if;'
          || E'\n' || '      if q.status_code is null or q.status_code <> 200 or q.timed_out then';

  t3 text := '  v_ok := v_errs = 0;';
  r3 text := '  v_ok := v_errs = 0;'
          || E'\n' || '  -- 2026-11-28: every box score 404 and none landed = the host or URL changed, not missing games.'
          || E'\n' || '  if v_box_missing >= 3 and v_box_games = 0 then'
          || E'\n' || '    v_ok := false;'
          || E'\n' || '    v_error := coalesce(v_error || '' | '', '''') || ''every_boxscore_404 ('' || v_box_missing || '')'';'
          || E'\n' || '  end if;';

  t4 text := '''boxscore_games'', v_box_games, ''boxscore_rows'', v_box_rows,';
  r4 text := '''boxscore_games'', v_box_games, ''boxscore_rows'', v_box_rows, ''boxscore_not_found'', v_box_missing,';
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.nba_espn_drain()'::regprocedure;
  IF md5(v_src) IS DISTINCT FROM '69b3cd9df6dfd2479b8eb6cf835157cb' THEN
    RAISE EXCEPTION 'nba_espn_drain changed (md5 %) — re-read the live body before applying', md5(v_src);
  END IF;

  INSERT INTO flowty_archive.audit_20261128_nba_espn_drain_body (fn, prosrc, md5)
  VALUES ('nba_espn_drain()', v_src, md5(v_src)) ON CONFLICT (fn) DO NOTHING;

  v_new := v_src;
  v_n := (length(v_new) - length(replace(v_new, t1, ''))) / length(t1);
  IF v_n <> 1 THEN RAISE EXCEPTION 't1 occurs % times', v_n; END IF;
  v_new := replace(v_new, t1, r1);
  v_n := (length(v_new) - length(replace(v_new, t2, ''))) / length(t2);
  IF v_n <> 1 THEN RAISE EXCEPTION 't2 occurs % times', v_n; END IF;
  v_new := replace(v_new, t2, r2);
  v_n := (length(v_new) - length(replace(v_new, t3, ''))) / length(t3);
  IF v_n <> 1 THEN RAISE EXCEPTION 't3 occurs % times', v_n; END IF;
  v_new := replace(v_new, t3, r3);
  v_n := (length(v_new) - length(replace(v_new, t4, ''))) / length(t4);
  IF v_n <> 2 THEN RAISE EXCEPTION 't4 occurs % times', v_n; END IF;
  v_new := replace(v_new, t4, r4);

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.nba_espn_drain() RETURNS jsonb LANGUAGE plpgsql SET search_path TO %L, %L AS %L',
    'pg_catalog', 'public', v_new);

  RAISE NOTICE 'nba_espn_drain spliced: % -> % (md5 %)', md5(v_src), md5(v_new), md5(v_new);
END
$do$;
