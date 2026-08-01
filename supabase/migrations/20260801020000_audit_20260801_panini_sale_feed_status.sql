-- audit_20260801_panini_sale_feed_status
--
-- One-row self-measuring status of the Panini SERIAL sale-price feed, so the squeeze
-- board's disclosure can never go stale (same stance as panini_coverage_summary).
--
-- Upstream stopped supplying brought_at_price on 2026-07-29. `serials_with_recorded_price`
-- on panini_squeeze_board is therefore a FOSSIL count as of the last supplied day: it is
-- held (not erased) by trg_panini_preserve_sale_fields -- see
-- 20260801013000_audit_20260801_panini_preserve_sale_fossils.sql -- but it cannot grow while
-- the feed is out, so its ratio silently DECLINES as new serials are discovered (already
-- ~17% -> ~8%). A consumer that renders it as current price coverage would overclaim.
--
-- Consumed by app/api/public/insights/panini-squeeze/route.ts as meta.sale_price_feed,
-- fail-soft: a status error omits the block rather than 500-ing the board.
--
-- Scope note: this outage is confined to the serial-level getPskuTotalCardsList feed. FMV
-- derives from getCardMarketStats (volume_txns/avg_sale/recent_sale) and is UNAFFECTED --
-- verified 2026-07-31 by both a flat 83-93% sales-derived confidence mix across the outage
-- and, because volume_txns is cumulative and could mask a frozen feed, by confirming FMV
-- values still move (18-48% of re-snapshotted editions changed value on 07-29..07-31).

CREATE OR REPLACE VIEW public.panini_sale_feed_status AS
WITH supply AS (
  SELECT max(captured_at::date) FILTER (
           WHERE NULLIF(NULLIF(raw ->> 'brought_at_price', ''), '0') IS NOT NULL
         )                                                        AS last_supplied_on,
         count(*)                                                 AS total_serials,
         count(*) FILTER (WHERE last_sale_usd IS NOT NULL)         AS priced_serials,
         count(*) FILTER (WHERE last_sale_preserved_at IS NOT NULL) AS preserved_fossils
    FROM public.panini_card_serials
)
SELECT last_supplied_on,
       (CURRENT_DATE - last_supplied_on)                          AS days_since_last_supplied,
       total_serials,
       priced_serials,
       preserved_fossils,
       round(100.0 * priced_serials / NULLIF(total_serials, 0), 2) AS pct_serials_priced,
       (last_supplied_on >= CURRENT_DATE - 1)                      AS feed_ok
  FROM supply;

ALTER VIEW public.panini_sale_feed_status SET (security_invoker = on);
REVOKE ALL ON public.panini_sale_feed_status FROM anon, authenticated;

COMMENT ON VIEW public.panini_sale_feed_status IS
  'One-row self-measuring status of the Panini serial sale-price feed (upstream '
  'getPskuTotalCardsList.brought_at_price). feed_ok=false means upstream has not supplied '
  'sale prices since last_supplied_on, so priced_serials is a fossil count held by '
  'trg_panini_preserve_sale_fields rather than a current measurement — surfaces must '
  'disclose that instead of rendering it as live price coverage. Root cause 2026-07-29: '
  'brought_at_price went from "0"-or-number to JSON null for every serial.';
