-- audit_20261015_panini_sales_spread
--
-- 2026-10-15 (Claude Code cloud; Trevor: "Do what makes sense on these" — the Panini confidence relabel).
--
-- Input for FMV engine panini-1.3.0 (lib/chains/panini/ingest-normalize.ts toFmvRowV13): per edition id,
-- the COUNT, MIN and MAX of its last <=3 realized NON-special sales at any age — the exact input set
-- panini_last_sales_fmv takes its median from (panini_sales UNION each serial's last sale, deduped on
-- (sku, sold_at)). 1.3.0 keeps every 1.2.0 PRICE and re-grades only the LABEL from this spread.
--
-- MEASURED (2026-10-14, panini-1.2.0 snapshots vs the next real sale, 14 d, inputs gated on what the DB
-- held at snapshot time), within ±25 % by last-3 spread:
--   spread <= 1.5x : HIGH 74 % (1,939) · MEDIUM 65 % (954) · LOW 74 % (1,372)
--   1.5x – 3x      : HIGH 63 % (1,433) · MEDIUM 30 % (615) · LOW 38 % (496)
--   > 3x           : HIGH 29 % (102)   · MEDIUM 27 % (200) · LOW 31 % (204)
-- The 1.2.0 labels did not order accuracy (MEDIUM 46.8 % < LOW 59.3 % over 45 d); spread does, in every
-- label. Stale tail checked: tight editions whose newest sale is > 90 d old score 86 %.
--
-- anon-exec: revoked (panini_sales_spread) — REVOKE FROM PUBLIC, anon, authenticated below; service_role only (the ingest route).
-- Revert: DROP FUNCTION public.panini_sales_spread(text[]); and PANINI_FMV_ENGINE=1.2 (or git revert) on the route.

CREATE FUNCTION public.panini_sales_spread(p_edition_ids text[])
RETURNS TABLE (edition_id text, n_sales integer, min_usd numeric, max_usd numeric, newest_sale_at timestamptz)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT e.id,
         count(*)::int,
         min(z.p),
         max(z.p),
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

REVOKE ALL ON FUNCTION public.panini_sales_spread(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_sales_spread(text[]) TO service_role;

COMMENT ON FUNCTION public.panini_sales_spread(text[]) IS
  'panini-1.3.0 confidence input: per edition id, count/min/max of its last <=3 realized NON-special sales at any '
  'age (the panini_last_sales_fmv input set). The ingest route grades HIGH when max/min <= 1.5, MEDIUM when the '
  '1.2.0 label was HIGH (>=3 sales in 30 d) and max/min <= 3, else LOW. Prices are unchanged.';
