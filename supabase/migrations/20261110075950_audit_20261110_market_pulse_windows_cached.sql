-- anon-exec: intentional — compute_market_pulse_windows / refresh_market_pulse_windows_cache are new, service_role only (REVOKE below, asserted at the end); get_market_pulse_windows keeps its ACL (CREATE OR REPLACE, same signature).
-- 2026-11-09 ~11:59 PM PT (Cowork cloud; Trevor: "Keep going and work through the rest").
--
-- WHY. `/insights/market-pulse` was the largest runtime-error group on the board: 27 "read exceeded
-- 8000ms" events in 24 h, one or more per new deployment and per edge region, because every cold
-- ISR render ran get_market_pulse_windows() live — a 30-day aggregate over `sales`, `pinnacle_sales`
-- and `panini_sales` with six count(DISTINCT …) arms. pg_stat_statements over 8,979 calls: mean
-- 2,523 ms, stddev 3,337 ms, max 29,980 ms, 2,831 blocks READ per call. The page degrades honestly
-- when the read misses, but a visitor arriving after a deploy got a board that did not load.
--
-- WHAT. The aggregate moves behind a one-row cache refreshed by pg_cron every 10 minutes.
--   · compute_market_pulse_windows()          — the previous body, byte for byte (copied from the live
--                                               prosrc under an md5 guard, so no transcription).
--   · market_pulse_windows_cache              — one row: payload json + computed_at.
--   · refresh_market_pulse_windows_cache()    — computes, then writes the row.
--   · get_market_pulse_windows()              — returns the cached payload while it is younger than
--                                               25 minutes; otherwise computes live, exactly as before.
-- A refresh that stops therefore degrades to the OLD behaviour (and the old runtime error), never to
-- a silently stale board: the reader never serves a payload older than 25 minutes.
-- The windows inside the payload are relative to the refresh, so "24 h" can be up to ~10 minutes
-- behind the wall clock (25 at the fallback edge) on a page that already revalidates every 5.
--
-- Revert: SELECT cron.unschedule('rpc-market-pulse-cache'); then re-apply the get_market_pulse_windows
-- body from 20261021025602 (LANGUAGE sql); the cache table and the two helper functions can stay.

DO $mig$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_market_pulse_windows';
  IF v_src IS NULL THEN RAISE EXCEPTION 'get_market_pulse_windows not found'; END IF;
  IF md5(v_src) <> 'c8d8f638245b05d1d2a595705051eba9' THEN
    RAISE EXCEPTION 'get_market_pulse_windows body changed since this migration was written (md5 %)', md5(v_src);
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.compute_market_pulse_windows() RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''public'' SET work_mem TO ''16MB'' AS %L',
    v_src);
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.compute_market_pulse_windows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_market_pulse_windows() TO service_role;

CREATE TABLE IF NOT EXISTS public.market_pulse_windows_cache (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payload     json        NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.market_pulse_windows_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.market_pulse_windows_cache FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.market_pulse_windows_cache IS
  'One row: the Market Pulse payload as last computed by refresh_market_pulse_windows_cache() (pg_cron rpc-market-pulse-cache, every 10 min). Read only through get_market_pulse_windows(), which ignores it once older than 25 minutes.';

CREATE OR REPLACE FUNCTION public.refresh_market_pulse_windows_cache()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payload json;
  v_started timestamptz := clock_timestamp();
BEGIN
  v_payload := public.compute_market_pulse_windows();
  INSERT INTO public.market_pulse_windows_cache AS c (id, payload, computed_at)
  VALUES (1, v_payload, clock_timestamp())
  ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;
  RETURN jsonb_build_object(
    'collections', json_array_length(v_payload),
    'ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_market_pulse_windows_cache() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_market_pulse_windows_cache() TO service_role;

CREATE OR REPLACE FUNCTION public.get_market_pulse_windows()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '16MB'
AS $function$
DECLARE
  v_payload json;
BEGIN
  SELECT c.payload INTO v_payload
    FROM public.market_pulse_windows_cache c
   WHERE c.id = 1 AND c.computed_at > now() - interval '25 minutes';
  IF v_payload IS NOT NULL THEN
    RETURN v_payload;
  END IF;
  -- No fresh row (first run, or the refresh has stopped): compute live, as this function always did.
  RETURN public.compute_market_pulse_windows();
END
$function$;

SELECT public.refresh_market_pulse_windows_cache();

SELECT cron.schedule('rpc-market-pulse-cache', '9-59/10 * * * *',
  $cron$SELECT public.refresh_market_pulse_windows_cache()$cron$);

DO $mig$
BEGIN
  IF has_function_privilege('anon', 'public.compute_market_pulse_windows()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.compute_market_pulse_windows()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.refresh_market_pulse_windows_cache()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refresh_market_pulse_windows_cache()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_market_pulse_windows()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_market_pulse_windows()', 'EXECUTE')
     OR has_table_privilege('anon', 'public.market_pulse_windows_cache', 'SELECT')
     OR has_table_privilege('authenticated', 'public.market_pulse_windows_cache', 'SELECT') THEN
    RAISE EXCEPTION 'anon/authenticated access leaked on the market pulse cache objects';
  END IF;
  IF (SELECT count(*) FROM public.market_pulse_windows_cache) <> 1 THEN
    RAISE EXCEPTION 'market_pulse_windows_cache was not seeded';
  END IF;
END
$mig$;
