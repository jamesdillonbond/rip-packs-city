-- audit_20260804_fmv_cap_confidence_closed_market
--
-- Pricing path for closed markets: a collection whose secondary market has
-- ceased trading (collections.market_closed_at IS NOT NULL) cannot honestly
-- carry a confidence label more assertive than STALE, regardless of what the
-- sales/ask heuristic computed. The closure fact OVERRIDES the heuristic. This
-- is the missing enforcement the 2026-08-04 handoff called out: the closure
-- disclosure shipped earlier lived only in presentation code, while the data
-- layer kept stamping fresh HIGH/MEDIUM onto UFC editions whose last real sale
-- was 400+ days ago (fmv-recalc Step 6 re-stamps prior HIGH/MEDIUM forward as
-- fresh 1.7.0). A BEFORE INSERT trigger is the single lowest-level enforcement
-- point: it catches every writer (all 8 fmv-recalc insert paths, fmv-backfill,
-- any manual write, any future writer) and leaves stored data honest, so
-- fmv_current and the wmc denorm inherit the honest label. Mirrors the existing
-- fmv_snapshots_block_* guard triggers. STALE keeps the last-observed value
-- under an honest "old, not current" label; NO_DATA (no value) is untouched.
--
-- Applied live via MCP apply_migration 2026-08-03 (PT).
-- Revert:
--   DROP TRIGGER IF EXISTS fmv_snapshots_cap_closed_market_confidence_trg ON public.fmv_snapshots;
--   DROP FUNCTION IF EXISTS public.fmv_snapshots_cap_closed_market_confidence();
CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_closed_market_confidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.confidence IN ('HIGH','MEDIUM','LOW','SALES_ONLY','ASK_ONLY')
     AND EXISTS (
       SELECT 1 FROM public.collections c
       WHERE c.id = NEW.collection_id
         AND c.market_closed_at IS NOT NULL
     )
  THEN
    NEW.confidence := 'STALE';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS fmv_snapshots_cap_closed_market_confidence_trg ON public.fmv_snapshots;
CREATE TRIGGER fmv_snapshots_cap_closed_market_confidence_trg
  BEFORE INSERT ON public.fmv_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.fmv_snapshots_cap_closed_market_confidence();

-- One-off: relabel the CURRENT latest snapshot per UFC edition so the honest
-- state is live immediately (not only after the next daily recalc). The trigger
-- above makes this durable — future re-stamps are capped, so this cannot drift
-- back to MEDIUM within 24h the way a bare one-off UPDATE would.
WITH latest AS (
  SELECT DISTINCT ON (edition_id) edition_id, computed_at
  FROM public.fmv_snapshots
  WHERE collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'
  ORDER BY edition_id, computed_at DESC
)
UPDATE public.fmv_snapshots f
SET confidence = 'STALE'
FROM latest l
WHERE f.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'
  AND f.edition_id = l.edition_id
  AND f.computed_at = l.computed_at
  AND f.confidence IN ('HIGH','MEDIUM','LOW','SALES_ONLY','ASK_ONLY');
