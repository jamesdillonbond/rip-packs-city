-- audit_20261025: Panini per-edition ASK HISTORY lane (Top Shot parity pass, 2026-10-25 evening PT).
--
-- Nothing kept a history of a Panini edition's lowest ask, so ask charts and floor movers had no data (the 10-03
-- chart decision: "re-open only with a new ask/offer snapshot lane"). This is that lane, for asks:
--   · panini_edition_ask_daily — CHANGE rows only: a row on a PT day when the edition's lowest confirmed ask (or its
--     listed count, once a board row carries one) changed; low_ask_usd NULL = the edition left panini_market_board
--     (no ask re-read in 7 days). State on day D = the newest row with day <= D.
--   · refresh_panini_edition_ask_daily() — daily at 5:01 AM PT (12:01 UTC; minute :01 was free). ~0.6 s.
--   · Seeded 10-21..10-24 from the #202 shadow table (one board snapshot a day, ask only). An edition absent from the
--     shadow (it skipped editions with no FMV) is UNKNOWN, never inferred as unlisted.
-- Offers are NOT in the lane: a per-edition max(best_offer_usd) over panini_card_serials is a 46 s / ~744k-block
-- seq scan (measured), too heavy daily.
--
-- First run 2026-10-25 ~9:05 PM PT: seed 35,153 (10-21) + 2,137 / 688 / 592 change rows, board 1,482 rows today,
-- 143 "left the board" rows; 37,567 editions; 6.7 MB.
--
-- Revert: SELECT cron.unschedule('panini-edition-ask-daily'); DROP FUNCTION public.refresh_panini_edition_ask_daily();
--         DROP TABLE public.panini_edition_ask_daily;

-- anon-exec: revoked (refresh_panini_edition_ask_daily) — new SECURITY DEFINER writer; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE TABLE IF NOT EXISTS public.panini_edition_ask_daily (
  external_id       text        NOT NULL,
  day               date        NOT NULL,
  low_ask_usd       numeric,
  listed_count      integer,
  ask_confirmed_at  timestamptz,
  source            text        NOT NULL DEFAULT 'board',
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (external_id, day)
);

ALTER TABLE public.panini_edition_ask_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_edition_ask_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.panini_edition_ask_daily TO service_role;

COMMENT ON TABLE public.panini_edition_ask_daily IS
  'Panini per-edition ask history, CHANGE rows only (Top Shot parity lane, 2026-10-25): a row on a PT day when the lowest confirmed ask or the listed count changed. low_ask_usd NULL = no ask re-read in 7 days (the edition left panini_market_board). State on day D = the newest row with day <= D. source = board (daily refresh) or shadow_seed (10-21..10-25 from panini_fmv_ask_cap_shadow, ask only; an edition absent there is unknown, never inferred as unlisted). audit_20261025.';

CREATE OR REPLACE FUNCTION public.refresh_panini_edition_ask_daily()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_day     date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  v_rows    integer := 0;
BEGIN
  WITH cur AS MATERIALIZED (
    SELECT b.external_id::text AS external_id, b.low_ask_usd, b.listed_count::int AS listed_count, b.ask_confirmed_at
      FROM public.panini_market_board b
     WHERE b.low_ask_usd > 0
  ), prev AS MATERIALIZED (
    SELECT DISTINCT ON (h.external_id) h.external_id, h.low_ask_usd, h.listed_count
      FROM public.panini_edition_ask_daily h
     WHERE h.day < v_day
     ORDER BY h.external_id, h.day DESC
  ), changed AS (
    SELECT COALESCE(c.external_id, p.external_id) AS external_id,
           c.low_ask_usd, c.listed_count, c.ask_confirmed_at
      FROM cur c
      FULL JOIN prev p ON p.external_id = c.external_id
     WHERE (c.external_id IS NOT NULL AND (p.external_id IS NULL
              OR c.low_ask_usd IS DISTINCT FROM p.low_ask_usd
              OR (p.listed_count IS NOT NULL AND c.listed_count IS DISTINCT FROM p.listed_count)))
        OR (c.external_id IS NULL AND p.low_ask_usd IS NOT NULL)
  )
  INSERT INTO public.panini_edition_ask_daily AS h (external_id, day, low_ask_usd, listed_count, ask_confirmed_at, source, recorded_at)
  SELECT external_id, v_day, low_ask_usd, listed_count, ask_confirmed_at, 'board', v_started FROM changed
  ON CONFLICT (external_id, day) DO UPDATE SET
    low_ask_usd = EXCLUDED.low_ask_usd, listed_count = EXCLUDED.listed_count,
    ask_confirmed_at = EXCLUDED.ask_confirmed_at, source = EXCLUDED.source, recorded_at = EXCLUDED.recorded_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  PERFORM public.log_pipeline_run('panini-edition-ask-daily', v_started, v_rows, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'day', v_day));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-edition-ask-daily', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_panini_edition_ask_daily() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_edition_ask_daily() TO postgres, service_role;

-- Seed 10-21..10-25 from the #202 shadow (one snapshot a day): a row where the ask changed vs the edition's previous
-- shadow day, and the first day each edition appears. Ask only; absence there is NOT inferred as unlisted.
INSERT INTO public.panini_edition_ask_daily (external_id, day, low_ask_usd, listed_count, ask_confirmed_at, source)
SELECT external_id, day, live_ask_usd, NULL, ask_confirmed_at, 'shadow_seed'
  FROM (
    SELECT s.external_id, (s.snapshot_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
           s.live_ask_usd, s.ask_confirmed_at,
           lag(s.live_ask_usd) OVER (PARTITION BY s.external_id ORDER BY s.snapshot_at) AS prev_ask,
           row_number() OVER (PARTITION BY s.external_id, (s.snapshot_at AT TIME ZONE 'America/Los_Angeles')::date
                              ORDER BY s.snapshot_at DESC) AS rn
      FROM public.panini_fmv_ask_cap_shadow s
     WHERE s.live_ask_usd > 0
  ) x
 WHERE rn = 1 AND (prev_ask IS NULL OR prev_ask IS DISTINCT FROM live_ask_usd)
ON CONFLICT (external_id, day) DO NOTHING;

SELECT cron.schedule('panini-edition-ask-daily', '1 12 * * *', $$SELECT public.refresh_panini_edition_ask_daily()$$);
