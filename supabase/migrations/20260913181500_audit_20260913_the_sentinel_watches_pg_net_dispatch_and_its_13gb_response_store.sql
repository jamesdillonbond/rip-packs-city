-- audit_20260913: check_pg_net_dispatch() — the pg_net worker and its response
-- store become a sentinel arm ("pg_net Dispatch").
--
-- WHY. Every edge-function lane, every Atlas walk and every DB-dispatched probe
-- leaves the database through pg_net: a row in net.http_request_queue, a
-- background worker that sends it after the enqueuing transaction commits, a
-- response row in net._http_response. Nothing watched any of it:
--   • a STALLED worker (queue growing, no responses landing) reads as "the lanes
--     went silent" from every other arm — Pipeline Silence, the cadence arms,
--     Zero-Yield all key on pipeline_runs, which a lane whose dispatch never
--     left cannot write; the register records a head-of-line block on this
--     worker taking a lane down (#102/#103);
--   • the response store is the LARGEST relation on the instance: measured
--     2026-09-13 10:4x PT, net._http_response is 13 GB total for ~5,400 live
--     rows — 15 MB heap, 12 GB in pg_toast_51873 holding ~1.5 GB of live bodies
--     (5,400 × ~275 kB avg, sampled), the rest dead: the TOAST has NEVER been
--     autovacuumed (autovacuum_count 0, last_autovacuum NULL) — register #75,
--     database.md "A HEAP'S STATS DEFECT DOES NOT IMPLY ITS TOAST WAS FIXED".
--     It grew ~2 GB/day across 09-10 → 09-12 with no instrument reporting it.
--
-- WHAT IT READS, AND WHAT IT COSTS (this is a probe; 20260913155500 is why that
-- matters): queue count (unlogged, usually empty: 6 buffers), the last 10 min
-- of responses through _http_response_created_idx (50 buffers for 124 rows),
-- max(created) off the same index (4), the store size from the catalog, and
-- reltuples from pg_class (the parent is ANALYZEd hourly by pg_cron jobid 482).
-- No response body is read. Measured: 96 buffers, 1 ms.
--
-- ⚠ THE RECLAIM IS NOT DONE HERE, and one fact about it is new: `postgres`
-- holds MAINTAIN on net._http_response (has_table_privilege → true, PG 17.6),
-- so VACUUM FULL is executable by a session without the extension's owner —
-- register #75 filed it as needing the owner. It still takes ACCESS EXCLUSIVE
-- on the dispatch table for the copy (pg_net inserts and every reader block),
-- which the register rightly calls a maintenance-window decision and Trevor's.
-- ⛔ Plain VACUUM is the WRONG tool: it scans all 12 GB of toast (a session
-- started one at 10:3x PT during a spell and it was cancelled at the 2-minute
-- budget); VACUUM FULL copies only the 15 MB heap and the live toast chunks
-- through the toast index, and the table is UNLOGGED so there is no WAL.
--
-- Reader: lib/sentinel/pg-net.ts. Warn-only. Threshold row seeded below.
-- REVERT: DROP FUNCTION public.check_pg_net_dispatch();
--         DELETE FROM public.sentinel_threshold_config WHERE check_name = 'pg_net Dispatch';
CREATE OR REPLACE FUNCTION public.check_pg_net_dispatch()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH r AS (
    SELECT count(*)                                                     AS responses_10m,
           count(*) FILTER (WHERE timed_out OR error_msg IS NOT NULL)   AS errored_10m,
           count(*) FILTER (WHERE status_code >= 500)                    AS http5xx_10m
    FROM net._http_response
    WHERE created > now() - interval '10 minutes'
  )
  SELECT jsonb_build_object(
    'queued',           (SELECT count(*) FROM net.http_request_queue),
    'responses_10m',    r.responses_10m,
    'errored_10m',      r.errored_10m,
    'http5xx_10m',      r.http5xx_10m,
    'last_response_at', (SELECT max(created) FROM net._http_response),
    'store_bytes',      pg_total_relation_size('net._http_response'),
    'store_rows',       (SELECT reltuples::bigint FROM pg_class WHERE oid = 'net._http_response'::regclass),
    'ttl',              current_setting('pg_net.ttl', true),
    'batch_size',       current_setting('pg_net.batch_size', true)
  )
  FROM r;
$function$;

COMMENT ON FUNCTION public.check_pg_net_dispatch() IS
  'Sentinel "pg_net Dispatch" arm: queue depth, responses / errors / 5xx in the last 10 min, last response time, and the total size of net._http_response (heap + TOAST + indexes) with its row estimate. ~96 buffers per call, reads no body. Reader: lib/sentinel/pg-net.ts. The store size is register #75 (TOAST never autovacuumed); VACUUM FULL is the reclaim and a maintenance-window decision.';

REVOKE EXECUTE ON FUNCTION public.check_pg_net_dispatch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_pg_net_dispatch() TO postgres, service_role;

INSERT INTO public.sentinel_threshold_config (check_name, warn_at, crit_at, enabled, note)
VALUES ('pg_net Dispatch', 8589934592, NULL, true,
  'warn_at = total size of net._http_response in BYTES (default 8 GiB; the store holds six hours of bodies, ~1.5 GB live measured 2026-09-13, so anything several times that is dead TOAST — register #75). The queue-depth line (200 = one pg_net batch), the stalled-worker test (queued > 0 with no response in 10 min) and the error-share line (≥25% over ≥20 responses) live in lib/sentinel/pg-net.ts. Never critical. Seeded 2026-09-13.')
ON CONFLICT (check_name) DO NOTHING;
