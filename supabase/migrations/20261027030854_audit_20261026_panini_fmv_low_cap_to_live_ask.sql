-- audit_20261026_panini_fmv_low_cap_to_live_ask  (panini-1.4.1 — known-issues #202)
-- anon-exec: fmv_snapshots_cap_panini_low_to_live_ask() — new trigger function (RETURNS trigger, never callable through PostgREST); EXECUTE revoked FROM PUBLIC, anon, authenticated below and verified with has_function_privilege after apply.
--
-- 2026-10-26 ~8:10 PM PT (Cowork cloud; Trevor 8:02 PM: "Make decisions based upon what's best for RPC long term
-- and for our users, and take care of all of these"). #202's pre-registered rule (10-21): "a cap that wins on the
-- changed rows without losing on all goes in", judged on the forward shadow log panini_fmv_ask_cap_shadow
-- (pg_cron 774, daily since 10-21) because no Panini ask history exists to backtest against.
--
-- THE READ (panini_fmv_ask_cap_shadow_backtest(7), 2026-10-26 8:05 PM PT, next marketplace sale as truth):
--                                    n      within ±25 %        median ratio   median abs err
--   changed_by_low_cap  published    82        1.2 %              2.000          100.0 %
--                       capped_low   82       53.7 %              1.056           18.1 %
--   all                 published  2,484      65.7 %              1.000
--                       capped_low 2,484      67.4 %              1.000
--   by tier (all): HIGH 77.9 = 77.9 · MEDIUM 56.8 = 56.8 · LOW 33.3 → 43.2 · STALE 55.6 = 55.6 · ASK_ONLY 10.9 = 10.9
--   No tier loses; the 10-25 early read (n 34: 44.1 vs 0.0) held and strengthened at twice the n.
-- The wider all-tier variant also wins (changed n 106: 48.1 vs 1.9; it moves 17 HIGH sales 0.0 → 29.4), but it was
-- not the registered candidate and it reprices HIGH editions on a single listing — left for its own read.
--
-- WHAT: a BEFORE INSERT guard on fmv_snapshots — the one point every Panini FMV writer passes (the ingest route's
-- panini-1.4.0 rows; thin-sales-guard-v3) — caps a Panini LOW fmv_usd at the edition's lowest live ask, using
-- exactly the ask the shadow log scored: panini_market_board.low_ask_usd, i.e. min(price_usd) over the edition's
-- listed serials re-read in the last 7 days (idx_panini_serials_listed_edition). Stamps algo_version '_askcap'.
-- The cap only ever LOWERS; an edition with no confirmed ask is untouched; no label changes (confidence is internal).
-- Why the DB and not ingest-normalize.ts: same chokepoint as #208 / #209, so every writer is covered and the
-- engine code (1.4.0, PANINI_FMV_ENGINE kill switch) is unchanged.
--
-- Measured before apply (latest Panini LOW rows): 18,662 LOW, 17,577 with a confirmed ask, 2,029 above it
-- (median 2.0×; 75 at ≥ 10×; $39.3k → $22.1k). The re-stamp of those CURRENT rows is the next migration
-- (20261027030902), sent apart because the MCP write gate holds DDL and a data UPDATE in one file.
--
-- EXIT (weekly from ~11-02): panini_fmv_ask_cap_shadow_backtest(7) — the published LOW row should now read the
-- capped_low numbers (~43 % within ±25); fmv_sales_backtest is not wired for Panini.
-- FALSIFIER: published LOW within ±25 % below the uncapped shadow column (fmv_usd before the cap is still logged by
-- job 774 only as the board value, so compare against the backup table's old_fmv_usd) on two consecutive weekly
-- reads → drop the trigger.
-- REVERT: DROP TRIGGER fmv_snapshots_cap_panini_low_to_live_ask_trg ON public.fmv_snapshots;
--         DROP FUNCTION public.fmv_snapshots_cap_panini_low_to_live_ask();
--         UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--           FROM public.audit_20261026_panini_low_askcap_backup b WHERE f.id = b.snapshot_id;

CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_panini_low_to_live_ask()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Panini Blockchain (collections.id). Scoped by measurement (2026-10-26, #202).
  c_panini constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_ask numeric;
BEGIN
  IF NEW.collection_id = c_panini
     AND NEW.confidence = 'LOW'
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
    SELECT min(s.price_usd)
      INTO v_ask
      FROM public.editions e
      JOIN public.panini_card_serials s
        ON s.edition_external_id = e.external_id::text
     WHERE e.id = NEW.edition_id
       AND s.is_listed
       AND s.price_usd > 0
       AND s.captured_at > now() - interval '7 days';
    IF v_ask IS NOT NULL AND v_ask > 0 AND NEW.fmv_usd > v_ask THEN
      NEW.fmv_usd := round(v_ask, 2);
      NEW.algo_version := COALESCE(NEW.algo_version, '') || '_askcap';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fmv_snapshots_cap_panini_low_to_live_ask() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fmv_snapshots_cap_panini_low_to_live_ask() IS
  'BEFORE INSERT guard on fmv_snapshots (2026-10-26, known-issues #202, panini-1.4.1): a Panini LOW fmv_usd is capped at the edition''s lowest live ask (listed serials re-read in 7 days, the panini_market_board ask) and algo_version gains _askcap. Forward shadow read 10-21..10-26: on the 82 sales the cap changed, within ±25 % 1.2 % -> 53.7 %, ratio 2.0 -> 1.06; no tier loses. Pin: supabase/tests/fmv_snapshots_cap_panini_low_to_live_ask.sql.';

CREATE TRIGGER fmv_snapshots_cap_panini_low_to_live_ask_trg
  BEFORE INSERT ON public.fmv_snapshots FOR EACH ROW
  EXECUTE FUNCTION public.fmv_snapshots_cap_panini_low_to_live_ask();

CREATE TABLE IF NOT EXISTS public.audit_20261026_panini_low_askcap_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  capped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261026_panini_low_askcap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261026_panini_low_askcap_backup FROM PUBLIC, anon, authenticated;
