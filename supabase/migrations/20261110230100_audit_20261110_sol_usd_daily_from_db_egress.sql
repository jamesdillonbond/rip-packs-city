-- audit_20261110_sol_usd_daily_from_db_egress
--
-- WHY (Claude Code cloud, 2026-11-10 ~2:35 PM PT; Sentinel WARN, trust arm candy_sales_stale_hours breach_at 0 because
-- 375 > 50 unresolved Candy sales parked in 48 h). candy_sales_unresolved holds 2,578 open rows; 2,528 are
-- skip_reason = 'no_sol_rate' (block_time 2026-08-16 -> 11-09, 667.7 SOL). The candy-sales-indexer drain retries 300 a
-- run and resolves 0 with sol_days_primed = 0: its SOL/USD history comes only from CoinGecko, called from Vercel's
-- egress, and both /market_chart/range and /history fail there (the 11-08 range-prime fix never primed a day). The
-- same range call from the DATABASE's egress (pg_net) answered 200 at 2:29 PM PT with 2,042 hourly points, 86 of them
-- exactly on 00:00 UTC -- the /history basis das.ts documents (its 2026-08-12 point matched /history to the digit).
--
-- WHAT. public.sol_usd_daily(day, usd): the 00:00 UTC SOL/USD point per day, filled by sol_usd_daily_tick() through
-- pg_net (collect any landed response, then dispatch the last 100 days; > 90 days returns daily 00:00 points, < 90
-- hourly, and only points within 60 s of 00:00 are kept, so both shapes give the same basis). pg_cron every 6 h.
-- lib/chains/solana/das.ts primeSolUsdFromTable() loads it into the per-day cache before any CoinGecko call, so the
-- indexers price a past-day sale from it; a day missing here still falls back to CoinGecko, unchanged.
-- A day's 00:00 value is final once written, so an existing row is never overwritten (ON CONFLICT DO NOTHING).
--
-- anon-exec: revoked (sol_usd_daily_tick) -- new SECURITY DEFINER writer; REVOKE FROM PUBLIC, anon, authenticated; pg_cron runs it as postgres.
-- REVERT: SELECT cron.unschedule('rpc-sol-usd-daily'); DROP FUNCTION public.sol_usd_daily_tick();
--         DROP TABLE public.sol_usd_daily_requests; DROP TABLE public.sol_usd_daily;
--         (and remove primeSolUsdFromTable's calls; das.ts falls back to CoinGecko only, as before)

CREATE TABLE IF NOT EXISTS public.sol_usd_daily (
  day         date PRIMARY KEY,
  usd         numeric NOT NULL CHECK (usd > 0),
  source      text NOT NULL DEFAULT 'coingecko_range_0000utc',
  captured_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sol_usd_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sol_usd_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sol_usd_daily TO service_role;

CREATE TABLE IF NOT EXISTS public.sol_usd_daily_requests (
  request_id    bigint PRIMARY KEY,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  collected_at  timestamptz,
  status_code   integer,
  days_written  integer,
  error         text
);
ALTER TABLE public.sol_usd_daily_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sol_usd_daily_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sol_usd_daily_tick()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_n int;
  v_collected int := 0;
  v_written int := 0;
  v_dispatched bigint := NULL;
  v_err text := NULL;
  v_from bigint := extract(epoch FROM date_trunc('day', now() AT TIME ZONE 'UTC') - interval '100 days')::bigint;
  v_to   bigint := extract(epoch FROM now())::bigint;
BEGIN
  -- (1) collect every dispatched request whose response has landed (or give up on one older than 2 h)
  FOR r IN
    SELECT q.request_id, h.status_code, h.content, h.error_msg, (h.id IS NOT NULL) AS landed, q.dispatched_at
    FROM public.sol_usd_daily_requests q
    LEFT JOIN net._http_response h ON h.id = q.request_id
    WHERE q.collected_at IS NULL
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '2 hours' THEN
        UPDATE public.sol_usd_daily_requests SET collected_at = now(), error = 'no_response' WHERE request_id = r.request_id;
      END IF;
      CONTINUE;
    END IF;
    v_n := 0;
    IF r.status_code = 200 AND pg_input_is_valid(r.content, 'jsonb') THEN
      WITH pts AS (
        SELECT (p->>0)::bigint AS ms, (p->>1)::numeric AS usd
        FROM jsonb_array_elements(r.content::jsonb -> 'prices') p
      ), ins AS (
        INSERT INTO public.sol_usd_daily (day, usd)
        SELECT (to_timestamp(ms / 1000.0) AT TIME ZONE 'UTC')::date, usd
        FROM pts
        WHERE usd > 0
          AND ms % 86400000 < 60000                                   -- on 00:00 UTC (within 60 s): the /history basis
          AND (to_timestamp(ms / 1000.0) AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE 'UTC')::date  -- never today
        ON CONFLICT (day) DO NOTHING
        RETURNING 1
      )
      SELECT count(*) INTO v_n FROM ins;
      UPDATE public.sol_usd_daily_requests
         SET collected_at = now(), status_code = r.status_code, days_written = v_n
       WHERE request_id = r.request_id;
    ELSE
      UPDATE public.sol_usd_daily_requests
         SET collected_at = now(), status_code = r.status_code,
             error = left(coalesce(r.error_msg, r.content, 'http ' || r.status_code), 300)
       WHERE request_id = r.request_id;
      v_err := left(coalesce(r.error_msg, r.content, 'http ' || r.status_code), 300);
    END IF;
    v_collected := v_collected + 1;
    v_written := v_written + v_n;
  END LOOP;

  -- (2) dispatch the next window unless one is already in flight
  IF NOT EXISTS (SELECT 1 FROM public.sol_usd_daily_requests WHERE collected_at IS NULL) THEN
    SELECT net.http_get(
      url := 'https://api.coingecko.com/api/v3/coins/solana/market_chart/range?vs_currency=usd&from=' || v_from || '&to=' || v_to,
      headers := '{"Accept":"application/json"}'::jsonb,
      timeout_milliseconds := 20000
    ) INTO v_dispatched;
    INSERT INTO public.sol_usd_daily_requests (request_id) VALUES (v_dispatched);
  END IF;

  DELETE FROM public.sol_usd_daily_requests WHERE dispatched_at < now() - interval '14 days';

  PERFORM public.log_pipeline_run('sol-usd-daily', now(), v_collected, v_written, 0, v_err IS NULL, v_err,
    NULL, NULL, NULL,
    jsonb_build_object('via', 'pg_cron', 'collected', v_collected, 'days_written', v_written, 'dispatched', v_dispatched,
                       'days_held', (SELECT count(*) FROM public.sol_usd_daily),
                       'newest_day', (SELECT max(day) FROM public.sol_usd_daily)));
  RETURN jsonb_build_object('collected', v_collected, 'days_written', v_written, 'dispatched', v_dispatched, 'error', v_err);
END;
$$;

REVOKE ALL ON FUNCTION public.sol_usd_daily_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sol_usd_daily_tick() TO service_role;

SELECT cron.schedule('rpc-sol-usd-daily', '41 */6 * * *', $cmd$SELECT public.sol_usd_daily_tick();$cmd$);
