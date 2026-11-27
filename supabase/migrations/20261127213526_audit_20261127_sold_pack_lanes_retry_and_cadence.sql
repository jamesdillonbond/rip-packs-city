-- audit_20261127_sold_pack_lanes_retry_and_cadence
--
-- 2026-11-27 (PT, ~1:45 PM; Claude Code cloud; Trevor: "work through anything still unresolved").
--
-- WHY (two defects found reading the lanes' first 3 hours):
-- 1. dispatch_sold_pack_open_tx_reads skipped a pack whenever ANY read row existed for it except
--    'no_response' -- so a pack whose read came back HTTP 429 (Flow access-node rate limit) was never
--    asked again. 13 packs were stuck that way at 1:40 PM PT. A 429 / 5xx / 404 is not an answer.
-- 2. run_seed_sold_pack_pulls (pg_cron rpc-sold-pack-pull-seed, every 10 min) ran 55-120 s per tick
--    -- 3 of 14 ticks killed at the 120 s pg_cron cap -- while seeding 0 rows since the first drain.
--    New work for it arrives only when a sold pack is opened or a read lands, so hourly is enough.
--
-- WHAT: (1) splice into the dispatcher (md5-asserted base, unique anchor, transform must land): a pack
-- is skipped only while its read is in flight, once it reached a final outcome (pulls, contents,
-- nothing_to_opener, bad_json), or within an hour of its last collect -- anything else is asked again.
-- (2) the seed job moves to '9 * * * *'; its cadence watchlist row widens to match.
--
-- REVERT: re-apply dispatch_sold_pack_open_tx_reads from
--   20261127194434_audit_20261127_sold_pack_outcomes_v4_marketplace_sales.sql (prosrc md5
--   09ba7f0d06a3ee7dcb22fd6f184ffcd2); SELECT cron.schedule('rpc-sold-pack-pull-seed', '9-59/10 * * * *',
--   'SELECT public.run_seed_sold_pack_pulls()'); restore the watchlist row's 40 / 120.

-- NOTE: the `IF v_src IS NULL` guard was added to this file after it was applied (11-27 ~1:42 PM PT):
-- on an empty database md5(NULL) is NULL, which slipped past the base check and built a broken CREATE.
-- The applied object is identical; only a fresh replay behaves differently (it now raises).

DO $mig$
DECLARE
  v_src text; v_new text; v_args text;
  c_anchor constant text := $a$AND (q.outcome IS NULL OR q.outcome NOT IN ('no_response') ))$a$;
  c_new    constant text := $a$AND (q.outcome IS NULL
                               OR q.outcome IN ('pulls', 'contents', 'nothing_to_opener', 'bad_json')
                               -- 11-27: a 429 / 5xx / 404 / no_response is asked again, an hour on
                               OR q.collected_at > now() - interval '1 hour'))$a$;
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'dispatch_sold_pack_open_tx_reads';
  IF v_src IS NULL THEN
    RAISE EXCEPTION '%() not found', 'dispatch_sold_pack_open_tx_reads';
  END IF;
  IF md5(v_src) <> '09ba7f0d06a3ee7dcb22fd6f184ffcd2' THEN
    RAISE EXCEPTION 'base drifted: prosrc md5 %', md5(v_src);
  END IF;
  IF (length(v_src) - length(replace(v_src, c_anchor, ''))) / length(c_anchor) <> 1 THEN
    RAISE EXCEPTION 'anchor not unique';
  END IF;
  v_new := replace(v_src, c_anchor, c_new);
  IF position('a 429 / 5xx / 404 / no_response is asked again' in v_new) = 0 THEN
    RAISE EXCEPTION 'transform did not land';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.dispatch_sold_pack_open_tx_reads(%s) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS $f$%s$f$',
    v_args, v_new);
END
$mig$;

REVOKE ALL ON FUNCTION public.dispatch_sold_pack_open_tx_reads(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_sold_pack_open_tx_reads(integer) TO service_role;

SELECT cron.schedule('rpc-sold-pack-pull-seed', '9 * * * *', 'SELECT public.run_seed_sold_pack_pulls()');

UPDATE public.pipeline_cadence_watchlist
   SET max_silent_minutes = 150, max_minutes_without_success = 360,
       notes = notes || ' 2026-11-27 ~1:45 PM PT: moved to hourly (:09) -- 55-120 s a tick, seeding 0 after the first drain.'
 WHERE pipeline = 'sold-pack-pull-seed';
