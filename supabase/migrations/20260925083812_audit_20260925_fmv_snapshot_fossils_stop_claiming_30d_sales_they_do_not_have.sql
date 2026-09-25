-- 2026-09-25 (PT) — fmv_snapshots latest rows that claimed 30-day sales an
-- edition did not have.
--
-- Two writers in app/api/fmv-recalc/route.ts published a false count:
--   1. the main loop wrote `sales_count_30d = sales.length`, where `sales` is
--      the 90d-WIDENED set for thin editions (Step 2a-quater / -quinquies), so
--      the 90-day sample size was published under the 30-day column's name;
--   2. Step 6 (stale touch) re-stamped a cold edition's latest row with a fresh
--      computed_at while carrying `sales_count_30d` AND `days_since_sale`
--      forward verbatim — every touched row has ZERO sales in 30 days by the
--      query's own predicate (`rt.edition_id IS NULL`), and the frozen age sat
--      at exactly 30, one short of the `> 30` the 2026-08-04 trigger
--      fmv_snapshots_zero_stale_sales_count keys on, so the trigger never saw
--      the self-contradiction it exists to zero.
-- Surface: the edition page rendered "7 sales in the last 30 days · 30d since
-- last" on Candy "Bobby Witt Jr. — BLUE" 47 days after its last sale.
-- Measured before the repair (latest row per edition, all editions):
-- 7,642 rows above the true 30d count (part sample-size defect, part honest
-- drift since computed_at — NOT repaired here, the writer fix re-prices them
-- on their next cycle), 770 with a count > 0 and no 30d sale at all, of which
-- the re-stamped ones (computed_at within 2 days) are the population below.
--
-- Repair: for the LATEST row per edition, stamped within the last 2 days,
-- claiming 30d sales the edition does not have — count := 0 (both columns:
-- sales_count_7d mirrors 30d under algo 1.7.0) and days_since_sale := the true
-- age from the last priced sale (kept as-is when no priced sale exists).
-- History rows (older stamps) are left untouched: their count was the writer's
-- sample size at the time and is documented as such in the ledger.
--
-- Revert: none needed — the values written are the ones the sales table
-- states; the backup below holds the pre-image of every row changed.
-- Drop after 2026-10-01: audit_20260925_fmv_fossil_repair_backup.

CREATE TABLE IF NOT EXISTS public.audit_20260925_fmv_fossil_repair_backup AS
WITH latest AS (
  SELECT l.id, l.edition_id, l.sales_count_7d, l.sales_count_30d, l.days_since_sale, l.computed_at
  FROM public.editions e
  CROSS JOIN LATERAL (
    SELECT fs.id, fs.edition_id, fs.sales_count_7d, fs.sales_count_30d, fs.days_since_sale, fs.computed_at
    FROM public.fmv_snapshots fs WHERE fs.edition_id = e.id ORDER BY fs.computed_at DESC LIMIT 1
  ) l
  WHERE l.sales_count_30d > 0 AND l.computed_at > now() - interval '2 days'
)
SELECT l.*,
  (SELECT max(s.sold_at) FROM public.sales s WHERE s.edition_id = l.edition_id AND s.price_usd > 0) AS last_sold_at
FROM latest l
WHERE NOT EXISTS (
  SELECT 1 FROM public.sales s
  WHERE s.edition_id = l.edition_id AND s.price_usd > 0 AND s.sold_at >= now() - interval '30 days'
);
ALTER TABLE public.audit_20260925_fmv_fossil_repair_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_fmv_fossil_repair_backup FROM PUBLIC, anon, authenticated;

UPDATE public.fmv_snapshots fs
   SET sales_count_7d  = 0,
       sales_count_30d = 0,
       days_since_sale = CASE
         WHEN b.last_sold_at IS NOT NULL
           THEN GREATEST(0, round(extract(epoch FROM (now() - b.last_sold_at)) / 86400))::int
         ELSE fs.days_since_sale
       END
  FROM public.audit_20260925_fmv_fossil_repair_backup b
 WHERE fs.id = b.id
   AND fs.computed_at = b.computed_at;

-- Post-condition: no repaired row still claims a 30d sale, and every one with
-- a priced sale carries an age of at least 30 days.
DO $$
DECLARE v_bad int; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.audit_20260925_fmv_fossil_repair_backup;
  SELECT count(*) INTO v_bad
  FROM public.fmv_snapshots fs
  JOIN public.audit_20260925_fmv_fossil_repair_backup b ON b.id = fs.id
  WHERE fs.sales_count_30d <> 0
     OR (b.last_sold_at IS NOT NULL AND fs.days_since_sale < 30);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'fossil repair left % of % rows contradicting the sales table', v_bad, v_n;
  END IF;
  RAISE NOTICE 'fossil repair: % latest rows corrected', v_n;
END $$;
