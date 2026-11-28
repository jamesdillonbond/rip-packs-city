-- audit_20261128_topshot_moment_id_editions_job_gets_its_declared_budget
--
-- WHAT. pg_cron jobid 632 (`rpc-topshot-moment-id-editions`, `23 10 * * *` = 2:23 AM PT) gains the
-- `SET statement_timeout = '300s';` command prefix, so refresh_topshot_moment_id_editions() actually runs under
-- the 300 s budget its own definition declares (proconfig statement_timeout=300s). No function change.
--
-- WHY. A function-level SET statement_timeout is INERT under pg_cron (CLAUDE.md, database.md): the job runs under
-- the 120 s database default, and this daily build has sat at that cap for ten days — 92, 104, 88, 90, 94, 102,
-- 100, 119, 101 s, then 11-28 2:23 AM PT TIMEOUT at 120 s (inbox 2026-11-28T1611Z item 2). The prefix is the
-- established lever: 30+ active jobs carry it (e.g. 4, 235, 248, 352–354, 436, 846). Daily at the quiet hour, so
-- the larger budget costs nothing at peak. A `SET …;` prefix makes the command one transaction block; the
-- function already runs as one (advisory xact lock, ON COMMIT DROP temp table), so nothing changes there.
--
-- REVERT: SELECT cron.alter_job(632, command := 'SELECT public.refresh_topshot_moment_id_editions();');

DO $$
BEGIN
  IF (SELECT command FROM cron.job WHERE jobid = 632) IS DISTINCT FROM 'SELECT public.refresh_topshot_moment_id_editions();'
  OR (SELECT jobname FROM cron.job WHERE jobid = 632) IS DISTINCT FROM 'rpc-topshot-moment-id-editions' THEN
    RAISE EXCEPTION 'jobid 632 is not the job this migration was written against — re-read cron.job';
  END IF;
  PERFORM cron.alter_job(632, command := 'SET statement_timeout = ''300s''; SELECT public.refresh_topshot_moment_id_editions();');
END $$;
