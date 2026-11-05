-- 2026-11-04 (Claude Code cloud; Trevor: "Ship it now", then "Backtested rule (59 pins)") — Pinnacle gets the
-- ask-only history cap All Day / Top Shot have had since 10-29 (_histcap).
--
-- OEV1-RIO2-PDRO-S5 (Pedro, Digital Display /54) was $1,620 ASK_ONLY (0.9 x one $1,800 ask) after four sales
-- at $45-$107; it alone read "Pedro" market cap +971 % in 7 days. pinnacle-2.0.0-render-ask prices at 0.9 x
-- the lowest ask with no bound from the pin's own sales.
-- Rule: an ASK_ONLY price above 3x the median of the pin's last 3 positive sales (any age) is capped there and
-- fmv_algo_version gains '_histcap' (the All Day / Top Shot rule; 3x is the house out-of-band bound).
-- Backtest, 120 d, Pinnacle sales whose price in force >= 1 d before was ASK_ONLY and above that bound
-- (n 17 of 2,225 ASK_ONLY targets): within +/-25 % 35.3 -> 41.2, WAPE 294.1 -> 98.3, median ratio 3.71 -> 2.38.
-- n 17 is under the house's ~60 bar; shipped on Trevor's call. It only ever LOWERS a price no sale supports.
-- Binds on 59 current pins today (largest $6,750 -> $3,777, Pedro $1,620 -> $300), backed up below.
-- One trigger covers every writer of pinnacle_catalog (pinnacle_fmv_recalc_render_all writes the plain
-- version string each run; the trigger re-appends the suffix). The AFTER fmv-history trigger records the
-- capped value.
--
-- anon-exec: revoked (pinnacle_catalog_cap_ask_only_to_sales_history) — new SECDEF trigger fn; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   DROP TRIGGER pinnacle_catalog_cap_ask_only_to_sales_history_trg ON public.pinnacle_catalog;
--   DROP FUNCTION public.pinnacle_catalog_cap_ask_only_to_sales_history();
--   UPDATE public.pinnacle_catalog c SET fmv_usd = b.fmv_usd, fmv_algo_version = b.fmv_algo_version
--     FROM public.audit_20261104_pinnacle_ask_only_histcap_backup b WHERE c.render_id = b.render_id;

CREATE OR REPLACE FUNCTION public.pinnacle_catalog_cap_ask_only_to_sales_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_m3 numeric;
BEGIN
  -- An ASK_ONLY price above 3x the median of the pin's last 3 sales (any age) is capped there and marked
  -- _histcap — the rule fmv_snapshots_cap_allday_ask_only_to_recent_sales applies to All Day / Top Shot.
  IF NEW.fmv_confidence::text = 'ASK_ONLY' AND NEW.fmv_usd IS NOT NULL AND NEW.render_id IS NOT NULL THEN
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x.p)
      INTO v_m3
      FROM (SELECT s.sale_price_usd AS p
              FROM public.pinnacle_sales s
             WHERE s.render_id = NEW.render_id AND s.sale_price_usd > 0
             ORDER BY s.sold_at DESC
             LIMIT 3) x;
    IF v_m3 IS NOT NULL AND NEW.fmv_usd > 3 * v_m3 THEN
      NEW.fmv_usd := round(3 * v_m3, 2);
      IF coalesce(NEW.fmv_algo_version, '') NOT LIKE '%\_histcap' THEN
        NEW.fmv_algo_version := coalesce(NEW.fmv_algo_version, '') || '_histcap';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.pinnacle_catalog_cap_ask_only_to_sales_history() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER pinnacle_catalog_cap_ask_only_to_sales_history_trg
  BEFORE INSERT OR UPDATE OF fmv_usd, fmv_confidence ON public.pinnacle_catalog
  FOR EACH ROW EXECUTE FUNCTION public.pinnacle_catalog_cap_ask_only_to_sales_history();

CREATE TABLE public.audit_20261104_pinnacle_ask_only_histcap_backup AS
SELECT c.render_id, c.fmv_usd, c.fmv_confidence, c.fmv_algo_version, c.fmv_computed_at, round(3 * m.m3::numeric, 2) AS capped_to
  FROM public.pinnacle_catalog c
 CROSS JOIN LATERAL (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x.p) AS m3
                       FROM (SELECT s.sale_price_usd AS p FROM public.pinnacle_sales s
                              WHERE s.render_id = c.render_id AND s.sale_price_usd > 0
                              ORDER BY s.sold_at DESC LIMIT 3) x) m
 WHERE c.fmv_confidence::text = 'ASK_ONLY' AND c.fmv_usd IS NOT NULL AND m.m3 IS NOT NULL AND c.fmv_usd > 3 * m.m3;

ALTER TABLE public.audit_20261104_pinnacle_ask_only_histcap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261104_pinnacle_ask_only_histcap_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE n_b int; n_u int; n_left int;
BEGIN
  SELECT count(*) INTO n_b FROM public.audit_20261104_pinnacle_ask_only_histcap_backup;
  IF n_b < 40 OR n_b > 80 THEN
    RAISE EXCEPTION 'expected ~59 over-bound Pinnacle ASK_ONLY pins, got %', n_b;
  END IF;
  -- Re-touch: the BEFORE trigger above caps each row as it is written.
  UPDATE public.pinnacle_catalog c SET fmv_usd = c.fmv_usd
    FROM public.audit_20261104_pinnacle_ask_only_histcap_backup b WHERE c.render_id = b.render_id;
  GET DIAGNOSTICS n_u = ROW_COUNT;
  SELECT count(*) INTO n_left
    FROM public.pinnacle_catalog c JOIN public.audit_20261104_pinnacle_ask_only_histcap_backup b USING (render_id)
   WHERE c.fmv_usd IS DISTINCT FROM b.capped_to;
  IF n_u <> n_b OR n_left <> 0 THEN
    RAISE EXCEPTION 're-touched % of %, % not at their cap — rolled back', n_u, n_b, n_left;
  END IF;
END $$;
