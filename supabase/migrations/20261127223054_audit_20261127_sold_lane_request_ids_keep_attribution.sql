-- audit_20261127_sold_lane_request_ids_keep_attribution
--
-- 2026-11-27 (PT, ~2:40 PM; Claude Code cloud, autonomous pass).
--
-- WHY: the 4xx arm (check_edge_fn_http_failures) attributes a Sold-tab read by joining
-- net._http_response.id to sold_pack_open_tx_reads.request_id / sold_container_open_search.request_id.
-- Both tables hold ONE row per pack and keep only the LATEST request id:
--   * sold_pack_open_tx_reads overwrites request_id when it re-asks a read (since 20261127213526 a
--     429 is re-asked an hour on), so the earlier 429 response loses its join inside its own 2 h
--     window and files as an UNATTRIBUTED pg_net_http_429 (severity high). Measured 2:30 PM PT:
--     5 at 11:46 AM PT, 5 at 12:36 PM PT, 1 at 12:06 PM PT -- all lane-tick minutes (:x6), all 60-wide
--     batches whose other 55 rows ARE attributed.
--   * sold_container_open_search CLEARS request_id on collect (SET request_id = NULL), so a landed
--     response of that lane can never be attributed -- the pinnacle_sale_serial_reads shape.
-- (The other unattributed rows in the same alert -- the 12:29-12:32 PM PT mainnet26 / flowscan
-- 401 / 404 calls and the 12:57-1:00 PM PT 429 burst -- are the 11-27 retired-spork session's own
-- probes and the All Day scratch read; they age out of the 2 h window. Inbox 2026-11-27T2213Z.)
--
-- WHAT: sold_lane_request_ids keeps every request id either lane records (AFTER INSERT / UPDATE OF
-- request_id triggers; backfilled from the current rows), pruned after 3 days by pg_cron. The arm's
-- four Sold-tab joins move onto it (md5-asserted splice, unique anchors, transform must land).
-- Additive: the lane functions are untouched.
--
-- REVERT: restore check_edge_fn_http_failures from
--   20261127200810_audit_20261127_the_4xx_arm_attributes_the_sold_pack_lanes.sql (resulting prosrc md5
--   b113dd26801645f43eec010a45edbc26) by replacing the four joins back; then
--   SELECT cron.unschedule('rpc-sold-lane-request-ids-prune');
--   DROP TRIGGER sold_pack_open_tx_reads_request_id_log ON public.sold_pack_open_tx_reads;
--   DROP TRIGGER sold_container_open_search_request_id_log ON public.sold_container_open_search;
--   DROP FUNCTION public.log_sold_lane_request_id(); DROP TABLE public.sold_lane_request_ids;

CREATE TABLE IF NOT EXISTS public.sold_lane_request_ids (
  request_id  bigint PRIMARY KEY,
  lane        text NOT NULL CHECK (lane IN ('open_tx', 'container_search')),
  pack_nft_id text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sold_lane_request_ids_recorded_at_idx ON public.sold_lane_request_ids (recorded_at);
ALTER TABLE public.sold_lane_request_ids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sold_lane_request_ids FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sold_lane_request_ids TO service_role;

CREATE OR REPLACE FUNCTION public.log_sold_lane_request_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
BEGIN
  INSERT INTO public.sold_lane_request_ids (request_id, lane, pack_nft_id)
  VALUES (NEW.request_id, TG_ARGV[0], NEW.pack_nft_id)
  ON CONFLICT (request_id) DO NOTHING;
  RETURN NULL;
END
$f$;
REVOKE ALL ON FUNCTION public.log_sold_lane_request_id() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sold_pack_open_tx_reads_request_id_log ON public.sold_pack_open_tx_reads;
CREATE TRIGGER sold_pack_open_tx_reads_request_id_log
  AFTER INSERT OR UPDATE OF request_id ON public.sold_pack_open_tx_reads
  FOR EACH ROW WHEN (NEW.request_id IS NOT NULL)
  EXECUTE FUNCTION public.log_sold_lane_request_id('open_tx');

DROP TRIGGER IF EXISTS sold_container_open_search_request_id_log ON public.sold_container_open_search;
CREATE TRIGGER sold_container_open_search_request_id_log
  AFTER INSERT OR UPDATE OF request_id ON public.sold_container_open_search
  FOR EACH ROW WHEN (NEW.request_id IS NOT NULL)
  EXECUTE FUNCTION public.log_sold_lane_request_id('container_search');

INSERT INTO public.sold_lane_request_ids (request_id, lane, pack_nft_id)
SELECT request_id, 'open_tx', pack_nft_id FROM public.sold_pack_open_tx_reads WHERE request_id IS NOT NULL
ON CONFLICT (request_id) DO NOTHING;
INSERT INTO public.sold_lane_request_ids (request_id, lane, pack_nft_id)
SELECT request_id, 'container_search', pack_nft_id FROM public.sold_container_open_search WHERE request_id IS NOT NULL
ON CONFLICT (request_id) DO NOTHING;

DO $mig$
DECLARE
  v_src text; v_new text; v_args text;
  a1 constant text := 'LEFT JOIN public.sold_pack_open_tx_reads spr ON spr.request_id = r.id';
  n1 constant text := 'LEFT JOIN public.sold_lane_request_ids spr ON spr.request_id = r.id AND spr.lane = ''open_tx''';
  a2 constant text := 'LEFT JOIN public.sold_container_open_search scs ON scs.request_id = r.id';
  n2 constant text := 'LEFT JOIN public.sold_lane_request_ids scs ON scs.request_id = r.id AND scs.lane = ''container_search''';
  a3 constant text := 'LEFT JOIN public.sold_pack_open_tx_reads sx1 ON sx1.request_id = sr.id';
  n3 constant text := 'LEFT JOIN public.sold_lane_request_ids sx1 ON sx1.request_id = sr.id AND sx1.lane = ''open_tx''';
  a4 constant text := 'LEFT JOIN public.sold_container_open_search sx2 ON sx2.request_id = sr.id';
  n4 constant text := 'LEFT JOIN public.sold_lane_request_ids sx2 ON sx2.request_id = sr.id AND sx2.lane = ''container_search''';
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_edge_fn_http_failures';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures() not found';
  END IF;
  IF md5(v_src) <> 'b113dd26801645f43eec010a45edbc26' THEN
    RAISE EXCEPTION 'base drifted: prosrc md5 % is not the body this splice was written against', md5(v_src);
  END IF;
  IF (length(v_src) - length(replace(v_src, a1, ''))) / length(a1) <> 1
     OR (length(v_src) - length(replace(v_src, a2, ''))) / length(a2) <> 1
     OR (length(v_src) - length(replace(v_src, a3, ''))) / length(a3) <> 1
     OR (length(v_src) - length(replace(v_src, a4, ''))) / length(a4) <> 1 THEN
    RAISE EXCEPTION 'an anchor is not unique';
  END IF;
  v_new := replace(replace(replace(replace(v_src, a1, n1), a2, n2), a3, n3), a4, n4);
  IF position('JOIN public.sold_pack_open_tx_reads' in v_new) > 0
     OR position('JOIN public.sold_container_open_search' in v_new) > 0
     OR (length(v_new) - length(replace(v_new, 'JOIN public.sold_lane_request_ids', ''))) / length('JOIN public.sold_lane_request_ids') <> 4 THEN
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
BEGIN
  IF has_function_privilege('anon', 'public.check_edge_fn_http_failures(interval)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.check_edge_fn_http_failures(interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked';
  END IF;
END
$mig$;

SELECT cron.schedule('rpc-sold-lane-request-ids-prune', '41 4 * * *',
  $$DELETE FROM public.sold_lane_request_ids WHERE recorded_at < now() - interval '3 days'$$);
