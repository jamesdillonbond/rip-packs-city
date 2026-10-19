-- audit_20261019: Pinnacle floor-ask history — the instrument an ask-anchored price needs
--
-- WHY. Measured 2026-10-19 ~8:30 AM PT over 45 days of pinnacle_sales (n 1,052): the
-- ASK_ONLY price (pinnacle_catalog.floor_ask × 0.90) lands within ±25 % of the next sale
-- 78.1 % of the time (WAPE 15.4 %), against 58.2 % (41.7 %) for a median of the render's
-- last 5 sales, and it wins in every 90-day sales-count band. It is the most accurate
-- Pinnacle price we publish, ahead of HIGH (54.0 % / 41.9 % over the same window). The
-- obvious next question for #193 is whether HIGH/MEDIUM/LOW would also improve by
-- anchoring to the live ask, and that cannot be backtested today:
--   * pinnacle_catalog.floor_ask holds only the CURRENT floor (one sweep stamp);
--   * pinnacle_live_listings holds only the latest snapshot (23,290 rows, one seen_at);
--   * pinnacle_listing_events holds ListingAvailable only (130,050 rows since 05-11) and
--     no completions or removals, so the open book at a past time cannot be rebuilt
--     (CLAUDE.md: a window over a change-only feed is not a census).
--
-- WHAT. pinnacle_floor_ask_history(render_id, floor_ask, observed_at) gets a row whenever a
-- render's floor_ask CHANGES (including to NULL = no live ask), stamped with the sweep's
-- floor_ask_updated_at. It mirrors pinnacle_fmv_history's trigger capture, so every writer
-- of floor_ask is covered without touching pinnacle_catalog_set_floor_asks. The current
-- state of all catalog rows is seeded so the first read has a baseline. The value in force
-- at time T = the latest row with observed_at <= T (writes are change-only, like fmv history).
--
-- Size: one narrow row per floor change; at most one row per render per sweep (4/day).
--
-- Posture: operator table — RLS on with no policy, no anon/authenticated grants (the
-- 2026-09-11 norm). The trigger function is SECURITY DEFINER and not callable by anon.
--
-- REVERT:
--   DROP TRIGGER IF EXISTS pinnacle_catalog_floor_ask_history_upd_trg ON public.pinnacle_catalog;
--   DROP TRIGGER IF EXISTS pinnacle_catalog_floor_ask_history_ins_trg ON public.pinnacle_catalog;
--   DROP FUNCTION IF EXISTS public.pinnacle_catalog_floor_ask_history_capture();
--   DROP TABLE IF EXISTS public.pinnacle_floor_ask_history;
--
-- anon-exec: revoked (pinnacle_catalog_floor_ask_history_capture) — new trigger fn; REVOKE FROM PUBLIC, anon, authenticated below.

CREATE TABLE IF NOT EXISTS public.pinnacle_floor_ask_history (
  render_id   text        NOT NULL,
  floor_ask   numeric,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (render_id, observed_at)
);

ALTER TABLE public.pinnacle_floor_ask_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pinnacle_floor_ask_history FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.pinnacle_floor_ask_history IS
  'Change-only history of pinnacle_catalog.floor_ask per render (NULL = no live ask), written by trigger. Value in force at T = latest row with observed_at <= T. Built 2026-10-19 so an ask-anchored Pinnacle price can be backtested (#193).';

CREATE OR REPLACE FUNCTION public.pinnacle_catalog_floor_ask_history_capture()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.pinnacle_floor_ask_history (render_id, floor_ask, observed_at)
  VALUES (NEW.render_id, NEW.floor_ask, COALESCE(NEW.floor_ask_updated_at, now()))
  ON CONFLICT (render_id, observed_at) DO UPDATE
    SET floor_ask = EXCLUDED.floor_ask;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.pinnacle_catalog_floor_ask_history_capture() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER pinnacle_catalog_floor_ask_history_ins_trg
  AFTER INSERT ON public.pinnacle_catalog
  FOR EACH ROW WHEN (NEW.render_id IS NOT NULL AND NEW.floor_ask IS NOT NULL)
  EXECUTE FUNCTION public.pinnacle_catalog_floor_ask_history_capture();

CREATE TRIGGER pinnacle_catalog_floor_ask_history_upd_trg
  AFTER UPDATE OF floor_ask ON public.pinnacle_catalog
  FOR EACH ROW WHEN (NEW.render_id IS NOT NULL AND NEW.floor_ask IS DISTINCT FROM OLD.floor_ask)
  EXECUTE FUNCTION public.pinnacle_catalog_floor_ask_history_capture();

-- Baseline: the state of every catalog row as of its last sweep.
INSERT INTO public.pinnacle_floor_ask_history (render_id, floor_ask, observed_at)
SELECT c.render_id, c.floor_ask, c.floor_ask_updated_at
  FROM public.pinnacle_catalog c
 WHERE c.render_id IS NOT NULL AND c.floor_ask_updated_at IS NOT NULL
ON CONFLICT (render_id, observed_at) DO NOTHING;
