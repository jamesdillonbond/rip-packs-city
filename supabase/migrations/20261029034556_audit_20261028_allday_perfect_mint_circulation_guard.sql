-- audit_20261028: All Day perfect-mint premiums — exclude editions whose recorded circulation is contradicted by a sale.
--
-- Review of 20261029030012 (ledger 10-28 ~8:30 PM PT, item a): allday_perfect_mint_premiums_board identifies the
-- perfect mint as serial = circulation_count. 42 All Day editions have a sold serial above circulation_count, so their
-- circulation is wrong and "serial = circulation" is not the last mint. A perfect-mint sale now counts only when no
-- sale of that edition carries a higher serial. Measured before: 0 of those 42 on the board (18 rows), so the board
-- is unchanged today; this keeps a wrong circulation from ever headlining it. Body otherwise identical to
-- 20261029030012's (re-read live first); CREATE OR REPLACE restates WITH (security_invoker = on), which it would
-- otherwise reset. Grants are kept by CREATE OR REPLACE (service_role SELECT only).
-- anon-exec: n/a — creates no function.
--
-- Revert: re-apply the allday_perfect_mint_premiums_board block from 20261029030012 as CREATE OR REPLACE VIEW … WITH (security_invoker = on).

CREATE OR REPLACE VIEW public.allday_perfect_mint_premiums_board WITH (security_invoker = on) AS
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
            -- 2026-10-28 review (a): "serial = circulation" is the last mint only when the recorded circulation is
            -- right. 42 All Day editions have a sold serial ABOVE it (an edition recorded /3,000 sold serial 25,482),
            -- so for those the recorded circulation is wrong and the "perfect" serial is not the last one.
            AND NOT EXISTS (SELECT 1 FROM sales s3
                             WHERE s3.edition_id = s.edition_id AND s3.collection = 'nfl_all_day'::text
                               AND s3.serial_number > e2.circulation_count)
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
