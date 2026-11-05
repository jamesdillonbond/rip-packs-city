-- 2026-11-04 (Claude Code cloud) — Panini's second FMV table withholds what the published FMV withholds.
--
-- The Panini ingest writes every FMV twice: `panini_fmv_snapshots` (keyed by panini_editions.id) and,
-- through sync_panini_bridge, `fmv_snapshots`. On fmv_snapshots, `fmv_snapshots_block_phantoms` nulls any
-- fmv_usd > $10,000 that is not HIGH with >= 3 sales in 30 d — and the bridge carries no sales count, so on
-- the edition page EVERY Panini FMV over $10,000 is withheld (edition_fmv_current max = $10,000).
-- panini_fmv_snapshots had no guard, and it feeds the public Panini boards (mv_panini_squeeze,
-- panini_deal_board_all, panini_player_board, panini_special_serials_board, panini_nation_board, the pack-EV
-- models). Measured 11-04: 87 editions' current row over $10,000 ($3.40M; 15 HIGH), max $500,000
-- (Ousmane Dembélé Tiger Stripe /12, ASK_ONLY off a $1,000,000 ask, 0 sales). Public exposure: squeeze 18
-- rows, player board 8, special serials 35, and the deal board listed a $44,000 Cristiano Ronaldo serial as
-- "30 % off" a $62,509 FMV, basis fmv_only_no_recent_sales — a price its own edition page does not publish.
--
-- (1) BEFORE INSERT/UPDATE trigger: fmv_usd > 10000 -> NULL (the outcome fmv_snapshots already enforces).
-- (2) Each edition's CURRENT over-cap row nulled, backed up first. History rows are left for the backtests.
--
-- anon-exec: revoked (panini_fmv_snapshots_withhold_over_cap) — new trigger fn; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   DROP TRIGGER panini_fmv_snapshots_withhold_over_cap_trg ON public.panini_fmv_snapshots;
--   DROP FUNCTION public.panini_fmv_snapshots_withhold_over_cap();
--   UPDATE public.panini_fmv_snapshots p SET fmv_usd = b.fmv_usd
--     FROM public.audit_20261104_panini_fmv_over_cap_backup b WHERE p.id = b.id;

CREATE OR REPLACE FUNCTION public.panini_fmv_snapshots_withhold_over_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Same ceiling as fmv_snapshots_block_phantoms; a Panini row reaches fmv_snapshots with no sales count,
  -- so there every value above it is withheld. One number per edition across the site.
  IF NEW.fmv_usd > 10000 THEN
    NEW.fmv_usd := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.panini_fmv_snapshots_withhold_over_cap() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER panini_fmv_snapshots_withhold_over_cap_trg
  BEFORE INSERT OR UPDATE OF fmv_usd ON public.panini_fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.panini_fmv_snapshots_withhold_over_cap();

CREATE TABLE public.audit_20261104_panini_fmv_over_cap_backup AS
SELECT l.id, l.edition_id, l.fmv_usd, l.confidence, l.algo_version, l.computed_at
  FROM (SELECT DISTINCT ON (edition_id) id, edition_id, fmv_usd, confidence, algo_version, computed_at
          FROM public.panini_fmv_snapshots
         ORDER BY edition_id, computed_at DESC) l
 WHERE l.fmv_usd > 10000;

ALTER TABLE public.audit_20261104_panini_fmv_over_cap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261104_panini_fmv_over_cap_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE n_b int; n_u int;
BEGIN
  SELECT count(*) INTO n_b FROM public.audit_20261104_panini_fmv_over_cap_backup;
  IF n_b < 60 OR n_b > 120 THEN
    RAISE EXCEPTION 'expected ~87 current over-cap Panini rows, got %', n_b;
  END IF;
  UPDATE public.panini_fmv_snapshots p SET fmv_usd = NULL
    FROM public.audit_20261104_panini_fmv_over_cap_backup b WHERE p.id = b.id;
  GET DIAGNOSTICS n_u = ROW_COUNT;
  IF n_u <> n_b THEN
    RAISE EXCEPTION 'nulled % rows, backed up % — rolled back', n_u, n_b;
  END IF;
END $$;
