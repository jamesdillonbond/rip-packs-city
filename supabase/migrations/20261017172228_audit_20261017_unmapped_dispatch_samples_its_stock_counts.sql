-- audit_20261017_unmapped_dispatch_samples_its_stock_counts
-- anon-exec: topshot_index_unmapped_dispatch — CREATE OR REPLACE of 20261017161643's fn via its own pg_get_functiondef, identical signature and return type; ACL preserved (service_role only).
--
-- WHY (2026-10-17 10:30 AM PT). Every run of topshot_index_unmapped_dispatch (pg_cron
-- rpc-topshot-index-unmapped-hydrate, '2-58/4', 360 runs/day) ends with three stock counts
-- (backlog / skipped_predicted_uncovered / unpredicted) over the whole ~187 k-row queue:
-- EXPLAIN (ANALYZE, BUFFERS) 1,152,346 buffers / 0.94 s per call, ~415 M blocks a day. The
-- dispatch SELECT itself is ~232 k. No function, view, watchlist row or repo code reads
-- these three fields (grep + pg_proc + pipeline_cadence_watchlist, 10:28 AM PT); they are
-- for humans watching the drain.
-- WHAT. Compute them only on the :02 and :30 ticks (minute % 30 < 4, which tolerates a
-- start that slips a minute). Other ticks log JSON null / NULL rows_found — never 0, so a
-- skipped count cannot read as an empty queue. Dispatch logic is byte-identical.
-- Two asserted replacements on the live definition, gated on the live prosrc md5
-- 2cba7b0c5ef46d7479f27628c23c8d9c (the body 20261017161643 applied); any drift raises.
-- REVERT: re-apply the topshot_index_unmapped_dispatch body of 20261017161643.
DO $mig$
DECLARE
  v_oid oid := 'public.topshot_index_unmapped_dispatch(integer)'::regprocedure;
  v_def text;
  a_old constant text := E'    SELECT count(*) FILTER (WHERE NOT skippable),\n';
  a_new constant text := E'    -- 2026-10-17: the stock counts (~1.15 M buffers) run on the :02/:30 ticks only;\n'
                      || E'    -- other ticks log NULL, never 0.\n'
                      || E'    IF extract(minute FROM v_started)::int % 30 < 4 THEN\n'
                      || E'    SELECT count(*) FILTER (WHERE NOT skippable),\n';
  b_old constant text := E'      ) x;\n  EXCEPTION';
  b_new constant text := E'      ) x;\n    END IF;\n  EXCEPTION';
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_oid) <> '2cba7b0c5ef46d7479f27628c23c8d9c' THEN
    RAISE EXCEPTION 'topshot_index_unmapped_dispatch drifted from 20261017161643 — re-read before patching';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF (length(v_def) - length(replace(v_def, a_old, ''))) / length(a_old) <> 1 THEN
    RAISE EXCEPTION 'replacement A: expected exactly 1 occurrence';
  END IF;
  IF (length(v_def) - length(replace(v_def, b_old, ''))) / length(b_old) <> 1 THEN
    RAISE EXCEPTION 'replacement B: expected exactly 1 occurrence';
  END IF;
  EXECUTE replace(replace(v_def, a_old, a_new), b_old, b_new);
END
$mig$;
