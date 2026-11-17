-- audit_20261026: Candy MLB per-edition MARKET HISTORY lane (Candy ↔ Top Shot parity, second pass).
--
-- Candy has had no recorded sale since 2026-10-11 (#58), so its edition charts (sales-driven) are flat while
-- its ask and bid books keep moving — and nothing kept a history of either: candy_listings overwrites a
-- listing's price in place, so yesterday's floor is unrecoverable. This lane records one row per Candy edition
-- per PT day, FORWARD ONLY (no backfill: a reconstruction from first/last-seen stamps would invent prices for
-- listings that were repriced in place):
--   · floor_ask_usd  — candy_listing_floor.confirmed_floor_usd (troll-capped, re-seen in 12 h); NULL = no listing
--                      confirmed that day.
--   · listed_count   — distinct tokens with a listing re-seen in 12 h (the edition page's "% Listed" rule).
--   · best_offer_usd / offer_count — active, unexpired Magic Eden bids (candy_best_offers' predicate).
-- A day the listings book itself was not re-read in 12 h is SKIPPED (no rows — unknown) and logged ok=false;
-- it never records "nothing listed" out of a dark sweep.
--
-- refresh_candy_edition_market_daily() — daily at 6:43 AM PDT (13:43 UTC), after the 12:35 UTC listings sweep.
-- 125 editions; idempotent per day (ON CONFLICT updates today's row).
--
-- Revert: SELECT cron.unschedule('candy-edition-market-daily'); DROP FUNCTION public.refresh_candy_edition_market_daily();
--         DROP FUNCTION public.get_candy_edition_market_history(uuid, integer); DROP TABLE public.candy_edition_market_daily;

CREATE TABLE IF NOT EXISTS public.candy_edition_market_daily (
  edition_id      uuid        NOT NULL,
  day             date        NOT NULL,
  floor_ask_usd   numeric,
  listed_count    integer     NOT NULL,
  best_offer_usd  numeric,
  offer_count     integer     NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (edition_id, day)
);

ALTER TABLE public.candy_edition_market_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_edition_market_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.candy_edition_market_daily TO service_role;

COMMENT ON TABLE public.candy_edition_market_daily IS
  'Candy MLB per-edition market history, one row per edition per PT day, forward only from 2026-10-26 (audit_20261026). floor_ask_usd = confirmed troll-capped floor (NULL = none confirmed that day); listed_count = tokens re-seen in 12 h; best_offer_usd/offer_count = active unexpired bids. A day with a stale listings book has NO rows (unknown), never zeros.';

-- anon-exec: revoked (refresh_candy_edition_market_daily) — new SECURITY DEFINER writer; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.refresh_candy_edition_market_daily()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_day     date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  v_coll    constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713';
  v_book_at timestamptz;
  v_rows    integer := 0;
BEGIN
  SELECT max(l.last_seen_at) INTO v_book_at
    FROM public.candy_listings l
   WHERE l.collection_id = v_coll AND l.is_active;

  IF v_book_at IS NULL OR v_book_at <= now() - interval '12 hours' THEN
    PERFORM public.log_pipeline_run('candy-edition-market-daily', v_started, 0, 0, 0, false,
      'listings book not re-read in 12 h — day skipped (unknown, not empty)',
      'candy_mlb', NULL, NULL, jsonb_build_object('source', 'audit_20261026', 'day', v_day, 'book_at', v_book_at));
    RETURN 0;
  END IF;

  WITH eds AS MATERIALIZED (
    SELECT e.id FROM public.editions e WHERE e.collection_id = v_coll
  ), lst AS MATERIALIZED (
    SELECT l.edition_id, count(DISTINCT l.token_mint)::int AS n
      FROM public.candy_listings l
     WHERE l.collection_id = v_coll AND l.is_active AND l.price_usd > 0
       AND l.last_seen_at > now() - interval '12 hours'
       AND (l.expiry IS NULL OR l.expiry > now())
     GROUP BY l.edition_id
  ), flr AS MATERIALIZED (
    SELECT f.edition_id, f.confirmed_floor_usd FROM public.candy_listing_floor f
  ), ofr AS MATERIALIZED (
    SELECT o.edition_id, max(o.price_usd) AS best, count(*)::int AS n
      FROM public.candy_offers o
     WHERE o.collection_id = v_coll AND o.is_active AND (o.expiry IS NULL OR o.expiry > now()) AND o.price_usd > 0
     GROUP BY o.edition_id
  )
  INSERT INTO public.candy_edition_market_daily AS h
    (edition_id, day, floor_ask_usd, listed_count, best_offer_usd, offer_count, recorded_at)
  SELECT eds.id, v_day, flr.confirmed_floor_usd, COALESCE(lst.n, 0), ofr.best, COALESCE(ofr.n, 0), v_started
    FROM eds
    LEFT JOIN lst ON lst.edition_id = eds.id
    LEFT JOIN flr ON flr.edition_id = eds.id
    LEFT JOIN ofr ON ofr.edition_id = eds.id
  ON CONFLICT (edition_id, day) DO UPDATE SET
    floor_ask_usd = EXCLUDED.floor_ask_usd, listed_count = EXCLUDED.listed_count,
    best_offer_usd = EXCLUDED.best_offer_usd, offer_count = EXCLUDED.offer_count, recorded_at = EXCLUDED.recorded_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  PERFORM public.log_pipeline_run('candy-edition-market-daily', v_started, v_rows, v_rows, 0, v_rows > 0, NULL,
    'candy_mlb', NULL, NULL, jsonb_build_object('source', 'audit_20261026', 'day', v_day, 'book_at', v_book_at));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('candy-edition-market-daily', v_started, 0, 0, 0, false, SQLERRM,
    'candy_mlb', NULL, NULL, jsonb_build_object('source', 'audit_20261026', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_candy_edition_market_daily() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_candy_edition_market_daily() TO postgres, service_role;

-- anon-exec: revoked (get_candy_edition_market_history) — service-role only; the edition page reads it server-side.
CREATE OR REPLACE FUNCTION public.get_candy_edition_market_history(p_edition_id uuid, p_days integer DEFAULT 60)
 RETURNS TABLE(day date, floor_ask_usd numeric, listed_count integer, best_offer_usd numeric, offer_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
  SELECT h.day, h.floor_ask_usd, h.listed_count, h.best_offer_usd, h.offer_count
    FROM public.candy_edition_market_daily h
   WHERE h.edition_id = p_edition_id
     AND h.day > (now() AT TIME ZONE 'America/Los_Angeles')::date - LEAST(GREATEST(COALESCE(p_days, 60), 1), 365)
   ORDER BY h.day DESC;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_candy_edition_market_history(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_candy_edition_market_history(uuid, integer) TO postgres, service_role;

-- First row today; then daily.
SELECT public.refresh_candy_edition_market_daily();
SELECT cron.schedule('candy-edition-market-daily', '43 13 * * *', $$SELECT public.refresh_candy_edition_market_daily()$$);
