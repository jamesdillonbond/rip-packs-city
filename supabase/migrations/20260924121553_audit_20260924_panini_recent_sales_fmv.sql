-- audit_20260924_panini_recent_sales_fmv
--
-- Input for the proposed panini-1.1.0 FMV (median of an edition's last <=3 non-special serial sales
-- in 30 days). Trevor approved the engine switch 2026-09-23 off panini_fmv_backtest; it is HELD
-- (not wired into /api/cron/panini-ingest) because the backtest's ground truth turned out to be the
-- TOP-SALES list only — see 20260924122029 and the runner's RECENT SALES switch. Unused until then.
-- anon-exec: revoked (panini_recent_sales_fmv) — REVOKE FROM PUBLIC, anon, authenticated below; verified has_function_privilege anon=false, authenticated=false, service_role=true.
-- Revert: DROP FUNCTION public.panini_recent_sales_fmv(text[]);

CREATE FUNCTION public.panini_recent_sales_fmv(p_edition_ids text[])
RETURNS TABLE (edition_id text, fmv_usd numeric, n_recent integer, newest_sale_at timestamptz)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT e.id,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY z.p))::numeric, 2),
         count(*)::int,
         max(z.t)
    FROM panini_editions e
    CROSS JOIN LATERAL (
      SELECT cs.last_sale_usd AS p, cs.last_sale_at AS t
        FROM panini_card_serials cs
       WHERE cs.edition_external_id = e.external_id
         AND cs.last_sale_usd > 0
         AND cs.last_sale_at > now() - interval '30 days'
         AND NOT COALESCE(cs.is_special, false)
       ORDER BY cs.last_sale_at DESC
       LIMIT 3) z
   WHERE e.id = ANY (p_edition_ids)
   GROUP BY e.id
$$;

REVOKE ALL ON FUNCTION public.panini_recent_sales_fmv(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_recent_sales_fmv(text[]) TO service_role;

COMMENT ON FUNCTION public.panini_recent_sales_fmv(text[]) IS
  'panini-1.1.0 FMV input: per edition id, the median of its last <=3 realized NON-special serial sales in the '
  'last 30 days (n_recent = how many). Called by /api/cron/panini-ingest (applyRecentSalesFmv). Chosen from '
  'panini_fmv_backtest 2026-09-23: 25.0% vs 35.9% median abs error for the lifetime-average FMV it replaces.';
