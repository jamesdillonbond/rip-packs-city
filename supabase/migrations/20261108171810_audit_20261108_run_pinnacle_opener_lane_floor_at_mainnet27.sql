-- audit_20261108_run_pinnacle_opener_lane_floor_at_mainnet27
--
-- WHY. 2026-11-08 ~9:10 AM PT (Claude Code, Trevor's Windows box). Flow retired the
-- access nodes access-001.mainnet24/25/26.nodes.onflow.org (#181: no DNS record);
-- a block before 130290659 (the mainnet27 root) is readable by no node. Two lanes
-- broke today when old work reached them and were floored at mainnet27
-- (20261108071848 Top Shot pull chain, 20261108164041 pack mint probes). This lane
-- still enqueues any no-opener open at/after the mainnet24 root and routes it to
-- v_nodes[1..3]. No exposure today (0 unattributed old opens; the last
-- pre-mainnet27 open was ingested 09-24; 0 pending/in-flight/failed windows below
-- the floor), but a re-ingest of old opens would send every tick's requests to
-- dead hosts and burn 6 attempts per window.
--
-- WHAT (minimal; the arrays stay so the stored spork index 1..5 keeps its meaning):
--   * v_floor 130290659 (mainnet27 root): enqueue reads open_block >= v_floor (was
--     >= v_roots[1], the mainnet24 root), and dispatch reads only windows with
--     lo >= v_floor -- so v_nodes[1..3] are unreachable.
--   * new step (0): a pending window with lo < v_floor is closed 'failed' with
--     "open block before 130290659 (mainnet27 root): Flow retired the mainnet24-26
--     access nodes, so the block is not readable by any node (#181)", no request.
--     An in-flight one returns to pending when its error lands and closes next tick.
--     Counted as extra.retired_pre_mainnet27 (not a failure: ok unchanged).
--   * done windows below the floor are never re-pended (no below-floor open reaches
--     the enqueue CTE).
--
-- PIN: supabase/tests/run_pinnacle_opener_lane.sql (re-based on mainnet27 / mainnet28;
--   new R1 - below-floor work is closed / never enqueued, and no request URL names
--   mainnet24-26).
-- anon-exec: unchanged (run_pinnacle_opener_lane) - CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- Revert: re-apply the run_pinnacle_opener_lane body from
--   20260929183000_audit_20260929_pinnacle_pack_openers_read_from_the_open_tx.sql
--   (windows closed by this step stay failed; re-open with
--    UPDATE pinnacle_opener_windows SET status='pending', attempts=0, finished_at=NULL
--     WHERE last_error LIKE 'open block before 130290659%').

CREATE OR REPLACE FUNCTION public.run_pinnacle_opener_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_per_node constant int := 10;
  v_max_att  constant int := 6;
  -- 2026-11-08: the mainnet27 root. Flow retired the mainnet24-26 access nodes
  -- (#181: no DNS record), so an open block before this height has no node that
  -- can read it. Such work is never enqueued or dispatched; a pending row is
  -- closed 'failed' with v_retired_msg. (Was the mainnet24 root, v_roots[1].)
  v_floor    constant bigint := 130290659;
  v_retired_msg constant text := 'open block before 130290659 (mainnet27 root): Flow retired the mainnet24-26 access nodes, so the block is not readable by any node (#181)';
  -- mainnet24..27 roots/ends; 28 = current spork. The mainnet24-26 entries stay
  -- so the stored spork index (1..5) keeps its meaning; nothing below v_floor
  -- reaches v_nodes[1..3] any more.
  v_roots    constant bigint[] := ARRAY[65264619, 85981135, 88226267, 130290659, 137390146]::bigint[];
  v_ends     constant bigint[] := ARRAY[85981134, 88226266, 130290658, 137390145, 9223372036854775807]::bigint[];
  v_nodes    constant text[] := ARRAY['http://access-001.mainnet24.nodes.onflow.org:8070',
                                      'http://access-001.mainnet25.nodes.onflow.org:8070',
                                      'http://access-001.mainnet26.nodes.onflow.org:8070',
                                      'http://access-001.mainnet27.nodes.onflow.org:8070',
                                      'https://rest-mainnet.onflow.org'];
  r record;
  v_body jsonb; v_n int; v_req bigint;
  v_collected int := 0; v_done int := 0; v_attributed int := 0; v_failed int := 0; v_throttled int := 0;
  v_expired int := 0; v_enqueued int := 0; v_dispatched int := 0; v_retired int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_pinnacle_opener_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (0) A pending window below the floor has no node to read it: close it as
  -- failed, saying why, never dispatch it. (An in-flight one returns to pending
  -- when its DNS failure lands and is closed on the next tick.)
  WITH ret AS (
    UPDATE public.pinnacle_opener_windows
       SET status = 'failed', request_id = NULL, last_error = v_retired_msg,
           finished_at = coalesce(finished_at, now())
     WHERE status = 'pending' AND lo < v_floor
    RETURNING 1
  )
  SELECT count(*) INTO v_retired FROM ret;

  -- (1) Collect.
  FOR r IN
    SELECT w.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
      FROM public.pinnacle_opener_windows w
      LEFT JOIN net._http_response h ON h.id = w.request_id
     WHERE w.status = 'in_flight'
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '30 minutes' THEN
        UPDATE public.pinnacle_opener_windows
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = 'no_response'
         WHERE spork = r.spork AND win = r.win;
        v_expired := v_expired + 1;
      END IF;
      CONTINUE;
    END IF;
    v_collected := v_collected + 1;
    v_body := CASE WHEN r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN r.h_content::jsonb END;
    IF v_body IS NULL OR jsonb_typeof(v_body) IS DISTINCT FROM 'array' THEN
      IF r.h_status = 429 THEN
        UPDATE public.pinnacle_opener_windows SET status = 'pending', request_id = NULL, last_error = 'http 429'
         WHERE spork = r.spork AND win = r.win;
        v_throttled := v_throttled + 1;
      ELSE
        v_last_error := left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300);
        UPDATE public.pinnacle_opener_windows
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = v_last_error,
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE spork = r.spork AND win = r.win;
        v_failed := v_failed + 1;
      END IF;
      CONTINUE;
    END IF;

    WITH ev AS MATERIALIZED (
      SELECT e->>'transaction_id' AS tx,
             convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb AS pl
        FROM jsonb_array_elements(v_body) b
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(b->'events', '[]'::jsonb)) e
    ), d AS MATERIALIZED (
      SELECT tx,
             (SELECT x->'value'->>'value' FROM jsonb_array_elements(pl->'value'->'fields') x WHERE x->>'name' = 'id') AS pin_id,
             (SELECT coalesce(x->'value'->'value'->>'value', x->'value'->>'value')
                FROM jsonb_array_elements(pl->'value'->'fields') x WHERE x->>'name' = 'to') AS to_addr
        FROM ev
    ), m AS (
      -- per open: the most common recipient of its pins in its own tx
      SELECT DISTINCT ON (o.pack_nft_id) o.pack_nft_id, d.to_addr
        FROM public.pinnacle_pack_opens o
        JOIN d ON d.tx = o.open_tx AND d.pin_id = ANY (o.nft_ids)
       WHERE o.opener_address IS NULL AND o.open_block BETWEEN r.lo AND r.hi AND d.to_addr IS NOT NULL
       GROUP BY o.pack_nft_id, d.to_addr
       ORDER BY o.pack_nft_id, count(*) DESC, d.to_addr
    ), upd AS (
      UPDATE public.pinnacle_pack_opens o SET opener_address = m.to_addr
        FROM m WHERE o.pack_nft_id = m.pack_nft_id AND o.opener_address IS NULL
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM upd;
    v_attributed := v_attributed + v_n;

    UPDATE public.pinnacle_opener_windows
       SET status = 'done', finished_at = now(), request_id = NULL, last_error = NULL, n_attributed = v_n,
           n_opens = (SELECT count(*) FROM public.pinnacle_pack_opens o WHERE o.open_block BETWEEN r.lo AND r.hi)
     WHERE spork = r.spork AND win = r.win;
    v_done := v_done + 1;
  END LOOP;

  -- (2) Enqueue (every 10 minutes, or when nothing is pending): windows with
  -- an open that has no opener; a done window is re-read when such an open was
  -- ingested after it finished.
  IF extract(minute FROM now())::int % 10 = 0
     OR NOT EXISTS (SELECT 1 FROM public.pinnacle_opener_windows WHERE status = 'pending') THEN
    WITH o AS (
      SELECT (SELECT min(i) FROM generate_subscripts(v_ends, 1) i WHERE v_ends[i] >= p.open_block) AS sp,
             p.open_block / 250 AS win, max(p.ingested_at) AS last_ingested
        FROM public.pinnacle_pack_opens p
       WHERE p.opener_address IS NULL AND p.open_block >= v_floor
       GROUP BY 1, 2
    ), ins AS (
      INSERT INTO public.pinnacle_opener_windows AS w (spork, win, lo, hi)
      SELECT o.sp, o.win, greatest(o.win * 250, v_roots[o.sp]), least(o.win * 250 + 249, v_ends[o.sp])
        FROM o WHERE o.sp IS NOT NULL
      ON CONFLICT (spork, win) DO UPDATE
        SET status = 'pending', request_id = NULL, attempts = 0
        WHERE w.status = 'done'
          AND w.finished_at < (SELECT max(p2.ingested_at) FROM public.pinnacle_pack_opens p2
                                WHERE p2.opener_address IS NULL AND p2.open_block BETWEEN w.lo AND w.hi)
      RETURNING 1
    )
    SELECT count(*) INTO v_enqueued FROM ins;
  END IF;

  -- (3) Dispatch: <= v_per_node per spork node, newest windows first.
  FOR r IN
    SELECT * FROM (
      SELECT w.*, row_number() OVER (PARTITION BY w.spork ORDER BY w.win DESC) AS rn
        FROM public.pinnacle_opener_windows w WHERE w.status = 'pending' AND w.lo >= v_floor
    ) z WHERE rn <= v_per_node
  LOOP
    SELECT net.http_get(
      url := v_nodes[r.spork] || '/v1/events?type=A.edf9df96c92f4595.Pinnacle.Deposit&start_height=' || r.lo || '&end_height=' || r.hi,
      timeout_milliseconds := 30000
    ) INTO v_req;
    UPDATE public.pinnacle_opener_windows
       SET status = 'in_flight', request_id = v_req, dispatched_at = now()
     WHERE spork = r.spork AND win = r.win;
    v_dispatched := v_dispatched + 1;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'pinnacle-pack-openers', v_started, v_collected, v_attributed, 0, (v_failed = 0), v_last_error,
    'disney_pinnacle', NULL, NULL,
    jsonb_build_object('windows_done', v_done, 'attributed', v_attributed, 'failed', v_failed,
                       'throttled', v_throttled, 'expired', v_expired, 'enqueued', v_enqueued,
                       'dispatched', v_dispatched, 'retired_pre_mainnet27', v_retired));
  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'windows_done', v_done,
                            'attributed', v_attributed, 'failed', v_failed, 'throttled', v_throttled,
                            'expired', v_expired, 'enqueued', v_enqueued, 'dispatched', v_dispatched,
                            'retired_pre_mainnet27', v_retired,
                            'last_error', v_last_error);
END;
$function$;
