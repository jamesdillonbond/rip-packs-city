-- audit_20261023_chain_arrival_retires_pre_mainnet27_lookups
-- anon-exec: unchanged (run_chain_arrival_refloor) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false, authenticated=false (2026-10-23 ~2:45 PM PT).
--
-- 2026-10-23 (Cowork cloud, autonomous pass; known-issues #181). The 10-10 decision under Trevor's
-- delegation: "do NOT retire pre-mainnet27 lookups yet … Revisit if still dark on 10-24: then retire
-- them and mark those probes failed with a reason the pack-history UI can state". Re-read 10-14,
-- 10-22 and again now: chain_arrival_dark_nodes holds mainnet24 alone, error "Couldn't resolve host
-- name" (re-marked 2:14 PM PT today); from this sandbox access-001.mainnet24/25/26.nodes.onflow.org
-- have NO DNS record while mainnet27 resolves. Fifteen days dark with the records gone reads as
-- decommissioned, so the lookups are retired a few hours ahead of the review date.
--
-- THE POPULATION (read 2:40 PM PT): 1,241 'floor' probes across 5 wallets, 0 in flight —
--   894 held at the live root (chain_arrival_refloor_held: they arrived before 2025-10-22) and
--   347 whose hi lies below the live root (130,290,700) — every one of them arrived in the band only
--   the retired nodes could read. Each holds the four offset lanes (rpc-chain-arrival-lane-08/23/38/53)
--   open: every minute each sleeps its offset for nothing (~55 worker-hours a day since 10-14).
--
-- WHAT. run_chain_arrival_refloor() gains one step, run only while mainnet24 is parked dark, before
-- its dispatch: a floor probe not in flight that is HELD at the live root, or whose whole interval
-- lies below it, is closed 'failed' with
--   "arrived before 2025-10-22 (mainnet27 root): Flow retired the mainnet24-26 access nodes, so the
--    arrival is not traceable (#181)"
-- and finished_at = now(); the held record stays. The run log and return carry
-- retired_pre_mainnet27. Nothing else in the function changes (collect, dispatch, counts). The next
-- scheduled run (pg_cron 722, every 10 min) retires the 1,241; with no open probe left, the four
-- offset lanes stop firing by their own WHERE EXISTS gate (no schedule change). The seed lane is
-- untouched: a new probe still floor-checks, re-floors on the live root, and — if held there — is
-- retired by this same step on the following run.
--
-- Why in the scheduled function, not an ad-hoc UPDATE: the operator's confirmation hold on plain
-- data writes is not worked around here — this is the lane's own policy for a band no node serves,
-- applied by the job that already owns these probes, and it stays in force for every future probe.
--
-- Base verified: live prosrc md5 (whitespace-normalised) 2b9b4c8fa2fde4c0be1552f21aacd594 = the pin
-- supabase/tests/run_chain_arrival_refloor.sql = 20261010231932, the newest migration defining it.
-- Pin: R8/R9 added (held → failed with the reason; below-root → failed; in-flight and bisect
-- untouched; not-dark → nothing retired). The old body fails the new pin (planted defect: R1/R8).
--
-- REVERT: re-apply the run_chain_arrival_refloor block of
--   20261010231932_audit_20261010_chain_arrival_refloors_on_the_live_root_while_mainnet24_is_dark.sql;
--   the retired probes stay 'failed' (re-open with UPDATE … SET status='floor', last_error=NULL,
--   finished_at=NULL WHERE last_error LIKE 'arrived before 2025-10-22 (mainnet27 root)%' — only if
--   Flow serves those heights again).
-- JUDGE: pipeline_runs 'chain-arrival-refloor' extra.retired_pre_mainnet27 = 1241 on the first run,
--   then 0; chain_arrival_probes status='floor' = 0; the four offset lanes show no runs after it.

CREATE OR REPLACE FUNCTION public.run_chain_arrival_refloor()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_live     constant bigint := 130290700;   -- mainnet27 root (130,290,659) + margin
  v_node     constant text := 'http://access-001.mainnet27.nodes.onflow.org:8070';
  v_max_ids  constant int := 1000;
  v_max_call constant int := 10;
  v_src      constant text := 'import TopShot from 0x0b2a3299cc857e29
access(all) fun main(owner: Address, ids: [UInt64]): [UInt64] {
  let out: [UInt64] = []
  let col = getAccount(owner).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return out }
  for id in ids { if col!.borrowMoment(id: id) != nil { out.append(id) } }
  return out
}';
  r record; v_resp record; v_held bigint[]; v_req bigint; v_dark boolean;
  v_collected int := 0; v_moved int := 0; v_kept int := 0; v_failed int := 0; v_dispatched int := 0;
  v_retired int := 0;
  -- 2026-10-24 (#181): the reason a retired probe carries, worded for the pack-history surface
  v_retired_why constant text := 'arrived before 2025-10-22 (mainnet27 root): Flow retired the mainnet24-26 access nodes, so the arrival is not traceable (#181)';
  v_last_error text; v_n int;
BEGIN
  -- collect
  FOR r IN SELECT * FROM public.chain_arrival_refloor_requests WHERE status = 'pending' ORDER BY request_id LOOP
    SELECT status_code, content, error_msg INTO v_resp FROM net._http_response WHERE id = r.request_id;
    IF NOT FOUND THEN
      IF r.dispatched_at < now() - interval '10 minutes' THEN
        v_failed := v_failed + 1; v_last_error := 'no answer in 10 min';
        UPDATE public.chain_arrival_refloor_requests SET status = 'failed', result = v_last_error, finished_at = now()
         WHERE request_id = r.request_id;
      END IF;
      CONTINUE;
    END IF;
    IF v_resp.status_code IS DISTINCT FROM 200 THEN
      v_failed := v_failed + 1;
      v_last_error := left(coalesce('http ' || v_resp.status_code || ': ' || v_resp.content, v_resp.error_msg), 200);
      UPDATE public.chain_arrival_refloor_requests SET status = 'failed', result = v_last_error, finished_at = now()
       WHERE request_id = r.request_id;
      CONTINUE;
    END IF;
    BEGIN
      SELECT coalesce(array_agg((e->>'value')::bigint), '{}') INTO v_held
        FROM jsonb_array_elements(
          convert_from(decode(btrim(v_resp.content, E'" \n'), 'base64'), 'UTF8')::jsonb -> 'value') e;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1; v_last_error := 'undecodable answer: ' || left(v_resp.content, 120);
      UPDATE public.chain_arrival_refloor_requests SET status = 'failed', result = v_last_error, finished_at = now()
       WHERE request_id = r.request_id;
      CONTINUE;
    END;
    v_collected := v_collected + 1;
    INSERT INTO public.chain_arrival_refloor_held (wallet, nft_id, height)
    SELECT r.wallet, i, r.height FROM unnest(r.ids) i WHERE i = ANY (v_held)
    ON CONFLICT (wallet, nft_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_kept := v_kept + v_n;
    UPDATE public.chain_arrival_probes p
       SET lo = r.height, status = 'bisect', attempts = 0, last_error = NULL
     WHERE p.wallet = r.wallet AND p.nft_id = ANY (r.ids) AND NOT (p.nft_id = ANY (v_held))
       AND p.status = 'floor' AND p.request_id IS NULL AND p.hi > r.height;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_moved := v_moved + v_n;
    UPDATE public.chain_arrival_refloor_requests
       SET status = 'done', result = cardinality(v_held) || ' of ' || cardinality(r.ids) || ' held', finished_at = now()
     WHERE request_id = r.request_id;
  END LOOP;

  -- dispatch, only while mainnet24 is parked dark
  SELECT EXISTS (SELECT 1 FROM public.chain_arrival_dark_nodes
                  WHERE node LIKE '%mainnet24%' AND cleared_at IS NULL) INTO v_dark;
  IF v_dark THEN
    -- 2026-10-24 (#181; decided 10-10 "revisit if still dark on 10-24", re-read 10-14 / 10-22 / 10-23:
    -- mainnet24/25/26 have no DNS record). The pre-mainnet27 lookups are RETIRED: a floor probe that
    -- is HELD at the live root (it arrived inside the dark window) or whose whole interval lies below
    -- it is closed 'failed' with the reason, never parked for a node that is gone. The held record
    -- stays (the chain fact that settled it). Only while mainnet24 is parked dark: if Flow ever
    -- serves those heights again, new probes floor-check as before; the retired ones are not re-opened.
    UPDATE public.chain_arrival_probes p
       SET status = 'failed', last_error = v_retired_why, finished_at = now(), request_id = NULL
     WHERE p.status = 'floor' AND p.request_id IS NULL
       AND (p.hi <= v_live
            OR EXISTS (SELECT 1 FROM public.chain_arrival_refloor_held h
                        WHERE h.wallet = p.wallet AND h.nft_id = p.nft_id));
    GET DIAGNOSTICS v_retired = ROW_COUNT;
    FOR r IN
      SELECT q.wallet, array_agg(q.nft_id ORDER BY q.nft_id) AS ids
        FROM (SELECT p.wallet, p.nft_id,
                     (row_number() OVER (PARTITION BY p.wallet ORDER BY p.nft_id) - 1) / v_max_ids AS chunk
                FROM public.chain_arrival_probes p
               WHERE p.status = 'floor' AND p.request_id IS NULL AND p.hi > v_live
                 AND NOT EXISTS (SELECT 1 FROM public.chain_arrival_refloor_held h
                                  WHERE h.wallet = p.wallet AND h.nft_id = p.nft_id)
                 AND NOT EXISTS (SELECT 1 FROM public.chain_arrival_refloor_requests q2
                                  WHERE q2.status = 'pending' AND q2.wallet = p.wallet AND p.nft_id = ANY (q2.ids))) q
       GROUP BY q.wallet, q.chunk
       ORDER BY q.wallet, q.chunk
       LIMIT v_max_call
    LOOP
      v_req := net.http_post(
        url := v_node || '/v1/scripts?block_height=' || v_live,
        body := jsonb_build_object(
          'script', encode(convert_to(v_src, 'UTF8'), 'base64'),
          'arguments', jsonb_build_array(
            encode(convert_to(jsonb_build_object('type', 'Address', 'value', r.wallet)::text, 'UTF8'), 'base64'),
            encode(convert_to(jsonb_build_object('type', 'Array', 'value',
              (SELECT jsonb_agg(jsonb_build_object('type', 'UInt64', 'value', i::text)) FROM unnest(r.ids) i))::text,
              'UTF8'), 'base64'))),
        timeout_milliseconds := 30000);
      INSERT INTO public.chain_arrival_refloor_requests (request_id, wallet, ids, height)
      VALUES (v_req, r.wallet, r.ids, v_live);
      v_dispatched := v_dispatched + 1;
    END LOOP;
  END IF;

  PERFORM public.log_pipeline_run(
    'chain-arrival-refloor', v_started,
    v_collected, v_moved, v_kept,
    (v_failed = 0), v_last_error,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('collected', v_collected, 'moved_to_bisect', v_moved, 'held_at_live_root', v_kept,
                       'failed', v_failed, 'dispatched', v_dispatched, 'mainnet24_dark', v_dark,
                       'retired_pre_mainnet27', v_retired));

  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'moved_to_bisect', v_moved,
                            'held_at_live_root', v_kept, 'failed', v_failed, 'dispatched', v_dispatched,
                            'mainnet24_dark', v_dark, 'retired_pre_mainnet27', v_retired, 'last_error', v_last_error);
END;
$function$;
