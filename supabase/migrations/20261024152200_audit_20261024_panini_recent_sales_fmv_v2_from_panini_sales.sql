-- audit_20261024_panini_recent_sales_fmv_v2_from_panini_sales
--
-- 2026-10-24 ~8:40 AM PT (Cowork cloud; Trevor: "Keep going" — the first interactive session on/after
-- 10-24, the owner the 10-19 decision named). Input for FMV engine panini-1.4.0 (lib/chains/panini/
-- ingest-normalize.ts toFmvRowV14): the 30-day "recent sales" read that prices HIGH/MEDIUM, taken from
-- the recorded SALES FEED (panini_sales) instead of the per-serial last-sale columns
-- (panini_card_serials.last_sale_*) that panini_recent_sales_fmv reads. Same contract: per edition id,
-- the MEDIAN and COUNT of its last <= 3 realized NON-special sales within 30 days, and the newest
-- sale's time. panini_recent_sales_fmv is left in place as the PANINI_FMV_ENGINE=1.3.1 kill switch.
--
-- WHY (the gate, decided 10-19 under delegation, roadmap-status "Decisions taken — the 10-19 thread"):
-- panini_sales_fmv_backtest (45 d, covered editions, scored against the sale that followed) —
--   10-19 read: sales median-3 MdAPE 11.8 % / within ±25 % 60.9 vs serials 13.4 % / 59.4 (n 27,746)
--   10-24 read at apply, both-predicted targets n 27,019: sales 5.3 % / 63.1 vs serials 8.3 % / 62.0,
--   median ratio 1.000 both; plus 5,214 covered targets only the sales feed can price (45.5 % within
--   ±25 %) — a serial's last_sale_* holds one sale per serial, so a serial that traded twice in the
--   window shows once, and the 30-day COUNT (which 1.3.0's MEDIUM and 1.3.1's spike guard key on)
--   under-reads. It waited for the 1.3.x live read (panini.md Now 1, done 10-23 and re-read this
--   morning with a 10-17 cutoff: tier order holds, HIGH 72.8 > MEDIUM 50.2 > LOW 23.3) so the two
--   engine changes do not pool into one measurement window.
--
-- EXIT (paired read, scripts/panini-fmv-paired-read.sql with 'panini-1.4.0' added, from ~10-29):
-- 1.4.0 HIGH within ±25 % at or above 1.3.1's 72.8 on the same-period rows, tier order kept.
-- FALSIFIER: 1.4.0 HIGH more than 3 pts under 1.3.1's paired figure, or MEDIUM below LOW, on two
-- consecutive weekly reads -> PANINI_FMV_ENGINE=1.3.1 on Vercel (no deploy needed).
--
-- anon-exec: revoked (panini_recent_sales_fmv_v2) — REVOKE FROM PUBLIC, anon, authenticated below; service_role only (the ingest route).
-- Revert: DROP FUNCTION public.panini_recent_sales_fmv_v2(text[]); and PANINI_FMV_ENGINE=1.3.1 (or git revert) on the route.

CREATE FUNCTION public.panini_recent_sales_fmv_v2(p_edition_ids text[])
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
      SELECT s.amount_usd AS p, s.sold_at AS t
        FROM panini_sales s
       WHERE s.edition_external_id = e.external_id
         AND s.amount_usd > 0
         AND s.sold_at > now() - interval '30 days'
         AND NOT EXISTS (SELECT 1 FROM panini_card_serials x WHERE x.sku = s.sku AND x.is_special)
       ORDER BY s.sold_at DESC
       LIMIT 3) z
   WHERE e.id = ANY (p_edition_ids)
   GROUP BY e.id
$$;

REVOKE ALL ON FUNCTION public.panini_recent_sales_fmv_v2(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_recent_sales_fmv_v2(text[]) TO service_role;
