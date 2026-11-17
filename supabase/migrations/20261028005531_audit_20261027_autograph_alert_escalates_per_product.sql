-- audit_20261027_autograph_alert_escalates_per_product
--
-- 2026-10-27 ~6:10 PM PT (Claude Code cloud; 10-20 review finding #4; Trevor: "make decisions autonomously").
--
-- WHAT WAS WRONG. The autograph arm of check_edge_fn_http_failures() escalated on the newest 200 across
-- ALL products, but autograph_sweep_requests sweeps two (`nba`, `nfl`, column `product`, NOT NULL). If
-- one product went 100 % 4xx while the other still answered 200, the arm stayed `info` and that
-- product's sweep stopped making progress with nobody told. Measured at apply: nba last 200 17:04Z,
-- nfl last 200 05:54Z — the two lanes do move independently.
--
-- WHAT THIS DOES. The same rule (no 200 in 2 h AND 3+ failed responses since the newest 200, from
-- 20261025164733) is evaluated PER PRODUCT, and the row is `high` when any product meets it. The detail
-- text says so and lists the newest 200 per product.
--
-- Spliced into the LIVE body on unique anchors (the 20261025164733 technique); refuses if an anchor is
-- missing or repeated, or if already patched.
--
-- REVERT: re-apply the prosrc read immediately before this migration (md5 d89f0f0f0cabcd0464a4f64aba98e0f9,
-- = the body 20261025164733 produced plus later splices; recorded in the ledger), or swap each new text
-- back to its anchor below.
--
-- anon-exec: unchanged (check_edge_fn_http_failures) — ACL restated below as in 20261025164733.

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text;
  c_ag_old constant text := $a$'severity', CASE WHEN ((SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200) IS NULL
                             OR (SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200) < now() - interval '2 hours')
                            AND (SELECT count(*) FROM public.autograph_sweep_requests
                                  WHERE drained_at IS NOT NULL AND status_code IS DISTINCT FROM 200
                                    AND drained_at > COALESCE((SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200), '-infinity'::timestamptz)) >= 3
                           THEN 'high' ELSE 'info' END,$a$;
  c_ag_new constant text := $a$'severity', CASE WHEN EXISTS (
                              SELECT 1
                                FROM (SELECT ap.product, max(ap.drained_at) FILTER (WHERE ap.status_code = 200) AS last_ok
                                        FROM public.autograph_sweep_requests ap GROUP BY ap.product) pp
                               WHERE (pp.last_ok IS NULL OR pp.last_ok < now() - interval '2 hours')
                                 AND (SELECT count(*) FROM public.autograph_sweep_requests ax
                                       WHERE ax.product = pp.product AND ax.drained_at IS NOT NULL AND ax.status_code IS DISTINCT FROM 200
                                         AND ax.drained_at > COALESCE(pp.last_ok, '-infinity'::timestamptz)) >= 3)
                           THEN 'high' ELSE 'info' END,$a$;
  c_txt_old constant text := 'THIS ROW ESCALATES TO high when no page has answered 200 in 2 h AND the last 3+ responses since it all failed (only matters mid-cycle: ';
  c_txt_new constant text := 'THIS ROW ESCALATES TO high when, for ANY product, no page has answered 200 in 2 h AND the last 3+ responses for that product since it all failed (only matters mid-cycle: ';
  c_last_old constant text := $a$'Last 200: ' || COALESCE(to_char((SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200) AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'never')$a$;
  c_last_new constant text := $a$'Last 200 per product: ' || COALESCE((SELECT string_agg(lp.product || ' ' || COALESCE(to_char(lp.last_ok AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'never'), ', ' ORDER BY lp.product)
                                                 FROM (SELECT product, max(drained_at) FILTER (WHERE status_code = 200) AS last_ok
                                                         FROM public.autograph_sweep_requests GROUP BY product) lp), 'never')$a$;
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_edge_fn_http_failures';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures() not found';
  END IF;
  IF position('$f$' in v_src) > 0 THEN
    RAISE EXCEPTION 'body contains the dollar-quote tag this migration uses';
  END IF;
  IF position('for ANY product, no page has answered 200' in v_src) > 0 THEN
    RAISE EXCEPTION 'already patched -- refusing to double-patch';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_ag_old, ''))) / length(c_ag_old) <> 1 THEN
    RAISE EXCEPTION 'autograph severity anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_txt_old, ''))) / length(c_txt_old) <> 1 THEN
    RAISE EXCEPTION 'autograph detail anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_last_old, ''))) / length(c_last_old) <> 1 THEN
    RAISE EXCEPTION 'autograph last-200 anchor is not unique';
  END IF;

  v_new := replace(v_src, c_ag_old, c_ag_new);
  v_new := replace(v_new, c_txt_old, c_txt_new);
  v_new := replace(v_new, c_last_old, c_last_new);

  IF position(c_ag_new in v_new) = 0 OR position(c_ag_old in v_new) > 0
     OR position(c_last_new in v_new) = 0 OR position(c_last_old in v_new) > 0 THEN
    RAISE EXCEPTION 'transform did not land';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.check_edge_fn_http_failures(%s) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp, net AS $f$%s$f$',
    v_args, v_new);
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) TO postgres, service_role;

DO $mig$
DECLARE v jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.check_edge_fn_http_failures(interval)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.check_edge_fn_http_failures(interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked on check_edge_fn_http_failures';
  END IF;
  v := public.check_edge_fn_http_failures(interval '2 hours');
  IF v IS NULL THEN RAISE EXCEPTION 'check_edge_fn_http_failures returned NULL'; END IF;
END
$mig$;
