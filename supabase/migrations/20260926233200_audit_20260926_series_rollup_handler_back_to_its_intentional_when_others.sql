-- 2026-09-26 (PT) — refresh_series_detail_rollup's FMV-refresh handler goes back
-- to `WHEN OTHERS`, as its owner decided.
--
-- 20260926233100 named query_canceled in two handlers to clear the R118 guard.
-- The owning session had cleared it the same hour the other way
-- (8bc7a5dd4: a `when-others-timeout-blind: intentional` marker in
-- 20260926193906), for a reason that holds: that handler's tail is the
-- per-collection LOOP, so catching a 57014 would let every remaining iteration
-- run after the timeout fired. This restores the live body to that file (guarded:
-- the anchor must match exactly once). refresh_pack_observed_values keeps the
-- named handler -- nothing but the pipeline log follows it.
-- anon-exec: unchanged (refresh_series_detail_rollup) — body splice of an existing fn; ACL preserved.
--
-- Revert: the same splice with the strings swapped.

DO $do$
DECLARE v text; n int;
  a constant text := $h$  -- 2026-09-26: query_canceled named -- a statement_timeout kill of the FMV
  -- refresh is the only error this job has had, and WHEN OTHERS cannot see it
  -- (R118; __tests__/new-plpgsql-recording-handlers-catch-query-canceled.test.ts).
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_fmv_err := SQLSTATE || ' ' || SQLERRM;$h$;
  b constant text := $h$  EXCEPTION WHEN OTHERS THEN
    v_fmv_err := SQLSTATE || ' ' || SQLERRM;$h$;
BEGIN
  SELECT pg_get_functiondef('public.refresh_series_detail_rollup(integer)'::regprocedure) INTO v;
  n := (length(v) - length(replace(v, a, ''))) / length(a);
  IF n <> 1 THEN RAISE EXCEPTION 'refresh_series_detail_rollup: anchor matched % times', n; END IF;
  EXECUTE replace(v, a, b);
END
$do$;
