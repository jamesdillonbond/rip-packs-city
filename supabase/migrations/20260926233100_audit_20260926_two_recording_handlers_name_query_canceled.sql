-- 2026-09-26 (PT) — two recording handlers name query_canceled.
--
-- WHY. __tests__/new-plpgsql-recording-handlers-catch-query-canceled.test.ts
-- (R118) reddened main from 8571d97df on: 20260926193906 re-shipped
-- refresh_series_detail_rollup with its FMV-refresh handler as `WHEN OTHERS` --
-- blind to a statement_timeout kill (57014), the only error that step has had --
-- and 20260926233000's refresh_pack_observed_values had the same shape. Both
-- handlers wrap a single statement (no LOOP), so catching the cancel is right.
-- The two migration files now carry `WHEN query_canceled OR OTHERS`; this applies
-- the same one-clause change to the live bodies (guarded: each anchor must match
-- exactly once), so each live body equals its file.
-- anon-exec: unchanged (refresh_series_detail_rollup, refresh_pack_observed_values) — body splices of existing fns; ACL preserved.
--
-- Revert: the same splices with the strings swapped.

DO $do$
DECLARE v text; n int;
  a constant text := $h$  EXCEPTION WHEN OTHERS THEN
    v_fmv_err := SQLSTATE || ' ' || SQLERRM;$h$;
  b constant text := $h$  -- 2026-09-26: query_canceled named -- a statement_timeout kill of the FMV
  -- refresh is the only error this job has had, and WHEN OTHERS cannot see it
  -- (R118; __tests__/new-plpgsql-recording-handlers-catch-query-canceled.test.ts).
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_fmv_err := SQLSTATE || ' ' || SQLERRM;$h$;
BEGIN
  SELECT pg_get_functiondef('public.refresh_series_detail_rollup(integer)'::regprocedure) INTO v;
  n := (length(v) - length(replace(v, a, ''))) / length(a);
  IF n <> 1 THEN RAISE EXCEPTION 'refresh_series_detail_rollup: anchor matched % times', n; END IF;
  EXECUTE replace(v, a, b);
END
$do$;

DO $do$
DECLARE v text; n int;
  a constant text := $h$  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);$h$;
  b constant text := $h$  -- a statement_timeout kill (57014) is named: WHEN OTHERS cannot see it (R118)
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);$h$;
BEGIN
  SELECT pg_get_functiondef('public.refresh_pack_observed_values()'::regprocedure) INTO v;
  n := (length(v) - length(replace(v, a, ''))) / length(a);
  IF n <> 1 THEN RAISE EXCEPTION 'refresh_pack_observed_values: anchor matched % times', n; END IF;
  EXECUTE replace(v, a, b);
END
$do$;
