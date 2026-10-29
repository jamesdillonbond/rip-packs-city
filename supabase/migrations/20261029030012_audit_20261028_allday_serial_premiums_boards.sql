-- audit_20261028: NFL All Day serial premiums — #1 and perfect-mint (All Day ↔ Top Shot parity; /insights/allday-serial-premiums).
--
-- Same columns as topshot_serial_premiums_board / topshot_perfect_mint_premiums_board, so lib/serial-premiums-board.ts
-- normalises both collections with one row shape. The headline sale is the edition's most recent #1 (or perfect-mint,
-- serial = circulation) sale in 90 days; the baseline is the edition's median sale over 180 days, from ≥ 15 sales.
-- ⚠ All Day thresholds differ from Top Shot's ON PURPOSE: Top Shot drops sales ≤ $0.50 and editions with a median
-- < $0.75. All Day commons trade around $0.20, so those floors left 2 perfect-mint rows of 56 sales (measured 10-28
-- ~8:05 PM PT). Here any positive sale counts and the median floor is $0.10 (the lowest qualifying median measured was
-- $0.15). Premium ≥ 5×, as on Top Shot. Measured: 12 #1 rows (median multiple 45×), 18 perfect-mint rows (6×).
-- All Day editions have no parallels, so is_conflated is always false (kept for the shared row shape).
-- Plain views (no materialisation): see the cost note at the bottom. security_invoker; service_role only.
-- anon-exec: n/a — creates no function.
--
-- Revert: DROP VIEW public.allday_serial_premiums_board; DROP VIEW public.allday_perfect_mint_premiums_board;

CREATE VIEW public.allday_serial_premiums_board WITH (security_invoker = on) AS
 WITH no1 AS (
         SELECT DISTINCT ON (s.edition_id) s.edition_id,
            s.price_usd AS no1_price,
            s.sold_at AS no1_sold_at,
            s.moment_id,
            s.nft_id
           FROM sales s
          WHERE s.collection = 'nfl_all_day'::text AND s.serial_number = 1
            AND s.sold_at >= (now() - '90 days'::interval) AND s.price_usd > 0::numeric
          ORDER BY s.edition_id, s.sold_at DESC
        ), ed_med AS (
         SELECT s.edition_id,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision)) AS edition_median,
            count(*) AS edition_sales_180d
           FROM sales s
          WHERE s.collection = 'nfl_all_day'::text AND s.sold_at >= (now() - '180 days'::interval) AND s.price_usd > 0::numeric
            AND s.edition_id IN (SELECT no1.edition_id FROM no1)
          GROUP BY s.edition_id
         HAVING count(*) >= 15
        )
 SELECT e.id AS edition_id,
    e.external_id,
    e.player_name,
    e.set_name,
    e.tier::text AS tier,
    e.circulation_count,
    e.thumbnail_url,
    n.moment_id,
    n.nft_id,
    round(m.edition_median::numeric, 2) AS edition_median_usd,
    round(n.no1_price::numeric, 2) AS no1_last_sale_usd,
    round((n.no1_price::double precision / m.edition_median)::numeric, 1) AS premium_multiple,
    n.no1_sold_at,
    m.edition_sales_180d,
    false AS is_conflated
   FROM no1 n
     JOIN ed_med m ON m.edition_id = n.edition_id
     JOIN editions e ON e.id = n.edition_id
  WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND e.thumbnail_url IS NOT NULL
    AND m.edition_median >= 0.10::double precision
    AND (n.no1_price::double precision / m.edition_median) >= 5::double precision
  ORDER BY (n.no1_price::double precision / m.edition_median) DESC;

CREATE VIEW public.allday_perfect_mint_premiums_board WITH (security_invoker = on) AS
 WITH perfect AS (
         SELECT DISTINCT ON (s.edition_id) s.edition_id,
            s.price_usd AS perfect_price,
            s.sold_at AS perfect_sold_at,
            s.moment_id,
            s.nft_id,
            s.serial_number
           FROM sales s
             JOIN editions e2 ON e2.id = s.edition_id
          WHERE s.collection = 'nfl_all_day'::text AND e2.circulation_count > 1 AND s.serial_number = e2.circulation_count
            AND s.sold_at >= (now() - '90 days'::interval) AND s.price_usd > 0::numeric
          ORDER BY s.edition_id, s.sold_at DESC
        ), ed_med AS (
         SELECT s.edition_id,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision)) AS edition_median,
            count(*) AS edition_sales_180d
           FROM sales s
          WHERE s.collection = 'nfl_all_day'::text AND s.sold_at >= (now() - '180 days'::interval) AND s.price_usd > 0::numeric
            AND s.edition_id IN (SELECT perfect.edition_id FROM perfect)
          GROUP BY s.edition_id
         HAVING count(*) >= 15
        )
 SELECT e.id AS edition_id,
    e.external_id,
    e.player_name,
    e.set_name,
    e.tier::text AS tier,
    e.circulation_count,
    e.thumbnail_url,
    p.moment_id,
    p.nft_id,
    p.serial_number AS perfect_serial,
    round(m.edition_median::numeric, 2) AS edition_median_usd,
    round(p.perfect_price::numeric, 2) AS perfect_last_sale_usd,
    round((p.perfect_price::double precision / m.edition_median)::numeric, 1) AS premium_multiple,
    p.perfect_sold_at,
    m.edition_sales_180d,
    false AS is_conflated
   FROM perfect p
     JOIN ed_med m ON m.edition_id = p.edition_id
     JOIN editions e ON e.id = p.edition_id
  WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND e.thumbnail_url IS NOT NULL
    AND m.edition_median >= 0.10::double precision
    AND (p.perfect_price::double precision / m.edition_median) >= 5::double precision
  ORDER BY (p.perfect_price::double precision / m.edition_median) DESC;

REVOKE ALL ON public.allday_serial_premiums_board FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.allday_perfect_mint_premiums_board FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.allday_serial_premiums_board TO service_role;
GRANT SELECT ON public.allday_perfect_mint_premiums_board TO service_role;

-- Cost (measured 10-28 ~8:15 PM PT, warm): the perfect-mint view reads ~170k buffers (all hits) in ~0.2 s, the #1 view
-- less. Readers are the board page (ISR 900 s) and the API route (edge cache 900 s), so a read is rare; no
-- materialised view or refresh job is needed. Re-measure if either becomes a hot path.
