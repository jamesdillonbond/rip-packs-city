-- audit_20261025_an_idle_atlas_lane_is_not_a_blocked_one
--
-- 2026-10-25 ~9:50 AM PT (Claude Code cloud; Trevor: "work on roadmap and known issues. Fix any issues you encounter").
--
-- WHAT PAGED. rpc_ops_snapshot().pipeline_alerts carried `atlas-usernames-upstream-403 · HIGH` at 16:43Z
-- ("1 of 2 … Last 200: 09:18Z"). Measured from member_wallet_username_requests: the lane dispatched
-- NOTHING between 09:08Z and 16:08Z (no wallet needed resolving — most ticks read
-- wallets_dispatched 0); the first dispatch after that idle spell (16:08Z, 1 wallet) caught the routine
-- ~5-15 % Cloudflare challenge, and because the newest 200 was > 6 h old the arm escalated to HIGH.
-- Nothing was blocked: 21 of the 22 preceding responses (24 h) were 200.
--
-- The arm's rule "high when no 200 has landed in N h" reads IDLE and BLOCKED identically. The autograph
-- arm (20261021024211) has the same shape at 2 h and its lane idles between cycles (since 10-20:
-- 7 dispatch gaps > 2 h, the longest ~20 h) — its own detail text says "a closed cycle dispatches
-- nothing and so cannot be challenged", but the FIRST page of the next cycle can be, and pages HIGH.
--
-- WHAT THIS DOES. Both arms escalate only when the old condition holds AND at least 3 responses
-- collected since the newest 200 failed. A real block still pages: each lane re-dispatches what failed,
-- so a sustained challenge produces consecutive failures within ~30 min of demand; three in a row at a
-- 15 % base rate is ~0.3 %. A lane with no demand loses nothing while blocked (nothing is dispatched),
-- so staying `info` until it next has work is the honest reading. The detail text says so.
--
-- Spliced into the LIVE body on unique anchors (the 20261002150259 / 20261021024211 technique); refuses if
-- an anchor is missing or repeated, or if already patched.
--
-- CONTROL (run after apply, recorded in the ledger): the 16:08Z single failure reads `info`; inside a
-- rolled-back transaction, three failed username rows after the newest 200 read `high`.
--
-- REVERT: re-apply the prosrc read immediately before this migration (md5 83a98a5f07a453a021ca77d6cb67b6c3,
-- recorded in the ledger entry), or swap each new severity CASE back to the anchor text below.
--
-- anon-exec: unchanged (check_edge_fn_http_failures) — ACL restated below as in 20261021024211.

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text;
  c_un_old constant text := $a$'severity', CASE WHEN (SELECT max(drained_at) FROM public.member_wallet_username_requests WHERE status_code = 200) IS NULL
                             OR (SELECT max(drained_at) FROM public.member_wallet_username_requests WHERE status_code = 200) < now() - interval '6 hours'
                           THEN 'high' ELSE 'info' END,$a$;
  c_un_new constant text := $a$'severity', CASE WHEN ((SELECT max(drained_at) FROM public.member_wallet_username_requests WHERE status_code = 200) IS NULL
                             OR (SELECT max(drained_at) FROM public.member_wallet_username_requests WHERE status_code = 200) < now() - interval '6 hours')
                            AND (SELECT count(*) FROM public.member_wallet_username_requests
                                  WHERE drained_at IS NOT NULL AND status_code IS DISTINCT FROM 200
                                    AND drained_at > COALESCE((SELECT max(drained_at) FROM public.member_wallet_username_requests WHERE status_code = 200), '-infinity'::timestamptz)) >= 3
                           THEN 'high' ELSE 'info' END,$a$;
  c_un_txt_old constant text := 'THIS ROW ESCALATES TO high when no 200 has landed on this lane in 6 h. ';
  c_un_txt_new constant text := 'THIS ROW ESCALATES TO high when no 200 has landed on this lane in 6 h AND the last 3+ responses since it all failed (an idle lane dispatches nothing, so a long gap alone is not a block). ';
  c_ag_old constant text := $a$'severity', CASE WHEN (SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200) IS NULL
                             OR (SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200) < now() - interval '2 hours'
                           THEN 'high' ELSE 'info' END,$a$;
  c_ag_new constant text := $a$'severity', CASE WHEN ((SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200) IS NULL
                             OR (SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200) < now() - interval '2 hours')
                            AND (SELECT count(*) FROM public.autograph_sweep_requests
                                  WHERE drained_at IS NOT NULL AND status_code IS DISTINCT FROM 200
                                    AND drained_at > COALESCE((SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200), '-infinity'::timestamptz)) >= 3
                           THEN 'high' ELSE 'info' END,$a$;
  c_ag_txt_old constant text := 'THIS ROW ESCALATES TO high when no page has answered 200 in 2 h (only matters mid-cycle: ';
  c_ag_txt_new constant text := 'THIS ROW ESCALATES TO high when no page has answered 200 in 2 h AND the last 3+ responses since it all failed (only matters mid-cycle: ';
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
  IF position('the last 3+ responses since it all failed' in v_src) > 0 THEN
    RAISE EXCEPTION 'already patched -- refusing to double-patch';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_un_old, ''))) / length(c_un_old) <> 1 THEN
    RAISE EXCEPTION 'usernames severity anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_un_txt_old, ''))) / length(c_un_txt_old) <> 1 THEN
    RAISE EXCEPTION 'usernames detail anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_ag_old, ''))) / length(c_ag_old) <> 1 THEN
    RAISE EXCEPTION 'autograph severity anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_ag_txt_old, ''))) / length(c_ag_txt_old) <> 1 THEN
    RAISE EXCEPTION 'autograph detail anchor is not unique';
  END IF;

  v_new := replace(v_src, c_un_old, c_un_new);
  v_new := replace(v_new, c_un_txt_old, c_un_txt_new);
  v_new := replace(v_new, c_ag_old, c_ag_new);
  v_new := replace(v_new, c_ag_txt_old, c_ag_txt_new);

  IF position(c_un_new in v_new) = 0 OR position(c_ag_new in v_new) = 0
     OR position(c_un_old in v_new) > 0 OR position(c_ag_old in v_new) > 0 THEN
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
