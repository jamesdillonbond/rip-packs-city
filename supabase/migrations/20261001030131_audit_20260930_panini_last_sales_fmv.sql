-- audit_20260930_panini_last_sales_fmv
--
-- Input for FMV engine panini-1.2.0 (Trevor approved 2026-09-30 ~8 PM PT). panini-1.1.0 priced an
-- edition with no sale in 30 days (LOW) at Panini's LIFETIME avg_sale. Week-one review 09-30: LOW ran
-- ~1.7-2.3x high and was most of the Hobby/FOTL pack EV. Measured 2026-09-30 (Cowork) over 45 days of
-- panini_sales, targets = non-special sales whose edition had no non-special sale in the prior 30 days:
--   fully-read editions (panini_sales_reads.complete_since <= sale), n=597:
--     lifetime average            MdAPE 82.5 %  ratio 1.83  within +/-25 % 22.1
--     median of last <=3, any age MdAPE 15.0 %  ratio 1.00  within +/-25 % 54.8
--   not-fully-read editions, n=1,871 (recorded history is partial): 70.4 % / 1.68 vs 66.7 % / 1.65.
-- So it is never worse, and the gain grows as the walk completes edition histories (~1,800/day).
-- This returns, per edition id, the median of its last <=3 realized NON-special sales at ANY age,
-- drawn from panini_sales (every recorded sale) UNION each serial's last sale (panini_card_serials),
-- deduped on (sku, sold_at). /api/cron/panini-ingest uses it ONLY where panini_recent_sales_fmv (the
-- 30-day HIGH/MEDIUM input, unchanged) has no hit.
-- anon-exec: revoked (panini_last_sales_fmv) — REVOKE FROM PUBLIC, anon, authenticated below; service_role only.
-- Revert: DROP FUNCTION public.panini_last_sales_fmv(text[]); and PANINI_FMV_ENGINE=1.1 (or git revert) on the route.

CREATE FUNCTION public.panini_last_sales_fmv(p_edition_ids text[])
RETURNS TABLE (edition_id text, fmv_usd numeric, n_sales integer, newest_sale_at timestamptz)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT e.id,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY z.p))::numeric, 2),
         count(*)::int,
         max(z.t)
    FROM panini_editions e
    CROSS JOIN LATERAL (
      SELECT DISTINCT ON (u.t, u.sku) u.p, u.t
        FROM (
          (SELECT s.sku, s.amount_usd AS p, s.sold_at AS t
             FROM panini_sales s
            WHERE s.edition_external_id = e.external_id
              AND s.amount_usd > 0
              AND NOT EXISTS (SELECT 1 FROM panini_card_serials x WHERE x.sku = s.sku AND x.is_special)
            ORDER BY s.sold_at DESC
            LIMIT 3)
          UNION ALL
          (SELECT cs.sku, cs.last_sale_usd, cs.last_sale_at
             FROM panini_card_serials cs
            WHERE cs.edition_external_id = e.external_id
              AND cs.last_sale_usd > 0
              AND cs.last_sale_at IS NOT NULL
              AND NOT COALESCE(cs.is_special, false)
            ORDER BY cs.last_sale_at DESC
            LIMIT 3)
        ) u
       ORDER BY u.t DESC, u.sku
       LIMIT 3) z
   WHERE e.id = ANY (p_edition_ids)
   GROUP BY e.id
$$;

REVOKE ALL ON FUNCTION public.panini_last_sales_fmv(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_last_sales_fmv(text[]) TO service_role;

COMMENT ON FUNCTION public.panini_last_sales_fmv(text[]) IS
  'panini-1.2.0 LOW-tier FMV input: per edition id, the median of its last <=3 realized NON-special sales at any '
  'age (panini_sales UNION serial last sales, deduped). Used by /api/cron/panini-ingest only when '
  'panini_recent_sales_fmv has no 30-day hit. Backtest 2026-09-30, fully-read editions n=597: MdAPE 15.0 % / '
  'ratio 1.00 vs 82.5 % / 1.83 for the lifetime average it replaces.';
