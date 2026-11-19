-- 2026-11-18 (PT, ~6:30 PM) — the failure_rate arm caps an UPSTREAM-530 lane at
-- `medium`, so a Dapper Studio outage stops paging every hour (#218).
--
-- CAUSE: Dapper's Studio GraphQL has answered HTTP 530 (Cloudflare "error code:
-- 1033", origin tunnel down) since ~4:23 PM PT 11-17. Every Studio-only lane
-- (compute-golazos-pack-ev, pinnacle-catalog-floor-refresh, pinnacle-wmc-render-id,
-- the Golazos half of snapshot-pack-asks) went >= 50 % failed, so this arm rated
-- each `high`, and /api/check-alerts emails + Telegrams on high (60-min debounce):
-- "🚨 RPC Pipeline Alert — 4 active" for an outage nobody here can fix. The pack-sales
-- Sentinel arms already hold WARN for this outage (11-17), and the Sentinel's
-- Pipeline Success Coverage arm got the same cap today (a8036159f).
--
-- FIX: the arm's severity CASE is wrapped. When it computes `high` AND the lane's
-- newest error names a 530 status (or Cloudflare 1033), the row is emitted at
-- `medium` instead and its detail says so. It is NOT dropped and NOT suppressed:
-- it stays on the board and in rpc_ops_snapshot(), and it re-pages at `high` the
-- moment the newest error is anything else. `critical` is never produced by this
-- arm, `medium`/`info` are untouched, and the restart/streak splits keep their
-- precedence (the cap applies to their output).
-- ⚠ 530 ONLY, as a status code. NOT 522/502/503/504 and not a timeout: a Supabase
-- `<!DOCTYPE html>` 522 is Cloudflare reporting OUR database unreachable
-- (CLAUDE.md), and must keep paging. Regex measured 11-18 on live error strings:
-- matches "gql: HTTP 530", "floor GQL 530", "pack listings HTTP 530", "error code:
-- 1033", "head fetch: HTTP 530", "2 gql chunk errors (first: GQL 530)"; does not
-- match "HTTP 522", "GQL 5301 rows", "wrote 15300 rows", statement timeouts, or the
-- bare "2 gql chunk errors" (the render-id lane names its cause in its error string
-- from the 11-18 render-lookup commit on; until its next run it still reads high).
--
-- Base: live prosrc md5 9926537c5244c96a38b339e013aa4866 (the 20260923231922 arm),
-- asserted below. Re-created from pg_get_functiondef(), so signature, SECURITY
-- DEFINER, search_path and ACL are preserved.
--
-- REVERT: swap each ($new$, $old$) pair below and re-run with the md5 guard set to
-- this migration's output md5.

DO $mig$
DECLARE
  def text;
  src text;
  o1 text := $old$    SELECT jsonb_build_object(
      'severity',
        CASE
          WHEN f.restart_in_window AND f.runs_since_restart >= 10 THEN$old$;
  n1 text := $new$    SELECT jsonb_build_object(
      'severity',
        -- 2026-11-18 (#218): an UPSTREAM-530 lane is capped at medium (does not page);
        -- it stays on the board and re-pages at high once its newest error is anything else.
        (SELECT CASE WHEN sv.v = 'high'
                      AND COALESCE(f.latest_error, f.last_error) ~* '(http|gql|status)\s*:?\s*530([^0-9]|$)|error code:\s*1033([^0-9]|$)'
                     THEN 'medium' ELSE sv.v END
           FROM (SELECT
        CASE
          WHEN f.restart_in_window AND f.runs_since_restart >= 10 THEN$new$;
  o2 text := $old$          WHEN f.fail_pct >= 50 THEN 'high'
          ELSE 'medium'
        END,
      'type',     'failure_rate',$old$;
  n2 text := $new$          WHEN f.fail_pct >= 50 THEN 'high'
          ELSE 'medium'
        END AS v) sv),
      'type',     'failure_rate',$new$;
  o3 text := $old$        ': ' || COALESCE(left(COALESCE(f.latest_error, f.last_error), 160), '(none recorded)')
    )
    FROM public.v_pipeline_failure_rates f$old$;
  n3 text := $new$        ': ' || COALESCE(left(COALESCE(f.latest_error, f.last_error), 160), '(none recorded)') ||
        CASE WHEN COALESCE(f.latest_error, f.last_error) ~* '(http|gql|status)\s*:?\s*530([^0-9]|$)|error code:\s*1033([^0-9]|$)'
             THEN ' — UPSTREAM 530 (Dapper Studio down, #218): capped at medium so it does not page; it re-pages at high once the newest error is anything else.'
             ELSE '' END
    )
    FROM public.v_pipeline_failure_rates f$new$;
  frag text; nf text; n int; i int;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.get_pipeline_alerts_core()'::regprocedure;
  IF md5(src) <> '9926537c5244c96a38b339e013aa4866' THEN
    RAISE EXCEPTION 'get_pipeline_alerts_core drifted (prosrc md5 %); re-derive before splicing', md5(src);
  END IF;
  def := pg_get_functiondef('public.get_pipeline_alerts_core()'::regprocedure);
  FOR i IN 1..3 LOOP
    frag := CASE i WHEN 1 THEN o1 WHEN 2 THEN o2 ELSE o3 END;
    nf   := CASE i WHEN 1 THEN n1 WHEN 2 THEN n2 ELSE n3 END;
    n := (length(def) - length(replace(def, frag, ''))) / length(frag);
    IF n <> 1 THEN RAISE EXCEPTION 'fragment % found % times, expected 1 — refusing to splice', i, n; END IF;
    def := replace(def, frag, nf);
  END LOOP;
  EXECUTE def;
  IF has_function_privilege('anon', 'public.get_pipeline_alerts_core()', 'execute') THEN
    RAISE EXCEPTION 'anon gained execute on get_pipeline_alerts_core()';
  END IF;
  -- The function must still run and still return an array.
  IF jsonb_typeof(public.get_pipeline_alerts_core()) <> 'array' THEN
    RAISE EXCEPTION 'get_pipeline_alerts_core() no longer returns an array';
  END IF;
END $mig$;
