-- audit_20260804_fmv_zero_stale_sales_count
--
-- Honesty guard on the sales-count denorm. fmv_snapshots carries BOTH
-- sales_count_30d and days_since_sale, so a single row can contradict itself.
-- When a collection's market freezes (UFC, closed 2026-05-13) or an edition
-- simply hasn't traded in a while, fmv-recalc Step 6 carries the prior row
-- forward -- re-stamping sales_count_30d unchanged while days_since_sale keeps
-- climbing. The result is a public moment page that says "7 sales / 30d" beside
-- a last sale 524 days ago, under a "Flow trading frozen since May 2026" banner:
-- the page disagrees with itself. This is the residual the closure work
-- (20cef621, fmv_snapshots_cap_closed_market_confidence) exposed -- that trigger
-- caps confidence to STALE but never touches the value or the count.
--
-- A row cannot honestly report 30-day sales when its own days_since_sale exceeds
-- 30. A BEFORE INSERT trigger (mirrors fmv_snapshots_cap_closed_market_confidence)
-- zeroes sales_count_30d on exactly that self-contradiction, for every writer, so
-- stored data -- and the fmv_current / wmc denorm that inherits it -- stays
-- honest. It NEVER touches fmv_usd, days_since_sale, confidence, or a row with a
-- genuine recent sale (days_since_sale <= 30), so the 577 live Top Shot editions
-- that are STALE-but-recently-traded and the legitimately-recent All Day rows are
-- untouched.
--
-- Measured pre-ship (2026-08-04 PT): 58 latest-per-edition rows self-contradict
-- (UFC 18, the systemic closure case; Top Shot + All Day + drift = the small
-- self-correcting tail). One Top Shot edition claimed 75 sales/30d with a last
-- sale over 30 days old.
--
-- Also revokes the default PUBLIC EXECUTE on both fmv_snapshots BEFORE INSERT
-- trigger functions (this one + the closure one): a trigger fires as its definer
-- regardless of the caller's EXECUTE privilege, so revoking anon/authenticated
-- shrinks the anon surface and clears check_secdef_anon_exec_drift() (which both
-- were tripping via the default grant).
--
-- Applied live via MCP 2026-08-04 (PT), in steps to stay under the tool timeout:
-- the two full-table DISTINCT ON scans (backup + one-off UPDATE) ran as separate
-- statements after the DDL. Committed here as one logical migration for the record.
--
-- Revert:
--   DROP TRIGGER IF EXISTS fmv_snapshots_zero_stale_sales_count_trg ON public.fmv_snapshots;
--   DROP FUNCTION IF EXISTS public.fmv_snapshots_zero_stale_sales_count();
--   UPDATE public.fmv_snapshots f
--     SET sales_count_30d = b.sales_count_30d
--     FROM public.audit_20260804_stale_sales_count_backup b
--     WHERE f.edition_id = b.edition_id AND f.computed_at = b.computed_at;
--   DROP TABLE IF EXISTS public.audit_20260804_stale_sales_count_backup;
--   -- (the PUBLIC-EXECUTE revoke is intentionally NOT reverted -- restoring an
--   --  anon-executable SECDEF trigger fn would only re-open the drift.)

CREATE OR REPLACE FUNCTION public.fmv_snapshots_zero_stale_sales_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- A row cannot honestly report 30-day sales when its own last sale is older
  -- than 30 days. Zero only that self-contradiction; never touch fmv_usd,
  -- days_since_sale, confidence, or a row with a genuine recent sale.
  IF COALESCE(NEW.days_since_sale, 0) > 30 AND COALESCE(NEW.sales_count_30d, 0) > 0 THEN
    NEW.sales_count_30d := 0;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS fmv_snapshots_zero_stale_sales_count_trg ON public.fmv_snapshots;
CREATE TRIGGER fmv_snapshots_zero_stale_sales_count_trg
  BEFORE INSERT ON public.fmv_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.fmv_snapshots_zero_stale_sales_count();

REVOKE EXECUTE ON FUNCTION public.fmv_snapshots_zero_stale_sales_count() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fmv_snapshots_cap_closed_market_confidence() FROM PUBLIC, anon, authenticated;

-- Back up the CURRENT latest self-contradictory rows before the one-off fix, so
-- the revert can restore the exact prior counts (the daily carry-forward would
-- otherwise carry the newly-zeroed value forward, making this non-self-reverting).
CREATE TABLE IF NOT EXISTS public.audit_20260804_stale_sales_count_backup (
  edition_id uuid,
  computed_at timestamptz,
  sales_count_30d integer
);
ALTER TABLE public.audit_20260804_stale_sales_count_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260804_stale_sales_count_backup FROM anon, authenticated;

WITH latest AS (
  SELECT DISTINCT ON (edition_id) edition_id, computed_at, sales_count_30d, days_since_sale
  FROM public.fmv_snapshots
  ORDER BY edition_id, computed_at DESC
)
INSERT INTO public.audit_20260804_stale_sales_count_backup (edition_id, computed_at, sales_count_30d)
SELECT edition_id, computed_at, sales_count_30d
FROM latest
WHERE COALESCE(days_since_sale, 0) > 30 AND COALESCE(sales_count_30d, 0) > 0;

-- One-off: zero the CURRENT latest snapshot per self-contradictory edition so the
-- honest state is live immediately (not only after the next daily recalc). The
-- trigger keeps it durable -- a future carry-forward re-stamp is re-zeroed.
UPDATE public.fmv_snapshots f
SET sales_count_30d = 0
FROM public.audit_20260804_stale_sales_count_backup b
WHERE f.edition_id = b.edition_id
  AND f.computed_at = b.computed_at
  AND COALESCE(f.sales_count_30d, 0) > 0;
