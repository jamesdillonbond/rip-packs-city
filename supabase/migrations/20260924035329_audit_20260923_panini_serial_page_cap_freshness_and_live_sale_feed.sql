-- audit_20260923_panini_serial_page_cap_freshness_and_live_sale_feed
--
-- Three Panini data-quality defects measured 2026-09-23 ~20:45 PT (Cowork), one migration so
-- PostgREST re-introspects once.
--
-- (1) THE SERIAL PAGE CAP. The runner reads getPskuTotalCardsList with `p: 1  l: 30
--     sortBy=new` and never requests page 2 (scripts/ingest-panini-runner.mjs, per-card detail
--     walk). So a walk re-reads at most 30 serials per edition: measured max(serials captured
--     in an edition's latest walk) = 30 exactly, in every size bucket. Consequences:
--       * 19,132 of 114,188 serials (16.8%, across 1,777 editions) were NOT re-read within 7 days
--         of their edition's latest walk; 8,910 not within 30 days.
--       * 15,674 of the 32,576 serial asks (48%) sit on those unconfirmed rows (median age 28 d).
--       * panini_deal_board: 312 of 696 rows, and 124 of 230 rows at >=50% discount, were
--         built on those unconfirmed asks.
--       * sales_missed = 11,442 of 27,797 sold serials over ~80 h of pipeline_runs (41%): realized
--         sales for serials we have never discovered, because discovery is the same capped page.
--     Edition-level FMV is NOT affected (getCardMarketStats), nor is serial_low_ask_usd (market
--     floor from the same edition-level payload).
--     This migration does NOT fix the cap (that is runner work); it (a) adds the instrument that
--     makes it measurable, and (b) stops the deal board presenting an unconfirmed ask as a deal.
--
-- (2) panini_sale_feed_status WAS A PERMANENTLY-RED INSTRUMENT PUBLISHING A FALSE CLAIM. It
--     measured raw->>'brought_at_price', which upstream nulled on 2026-07-29 and which the
--     2026-08-08 nftSalesData path REPLACED. It therefore read feed_ok=false /
--     last_supplied_on=2026-07-28 / 58 days, and /api/public/insights/panini-squeeze published
--     "no new ones can arrive" while the replacement feed was recording ~17 serial sales/day
--     (newest 2026-09-22 21:46 PT). The mirror face of the honesty rule: an "unknown/dead" that
--     is actually known/live. Redefined to measure the live feed: last_sale_at, the column
--     nftSalesData writes. Existing columns keep name, order and type (the route selects them);
--     three are appended.
--
-- Revert: re-apply the view bodies from 20260801020000 (sale feed), the live definitions of
-- panini_deal_board / panini_special_serials_board as of 20260919 (drop the appended columns
-- by DROP VIEW + CREATE, since CREATE OR REPLACE cannot remove columns), and
-- DROP VIEW public.panini_serial_freshness.

CREATE OR REPLACE VIEW public.panini_sale_feed_status WITH (security_invoker = on) AS
WITH supply AS (
  SELECT max(last_sale_at)                                                AS newest_sale_at,
         count(*)                                                         AS total_serials,
         count(*) FILTER (WHERE last_sale_usd IS NOT NULL)                AS priced_serials,
         count(*) FILTER (WHERE last_sale_preserved_at IS NOT NULL)       AS preserved_fossils,
         count(*) FILTER (WHERE last_sale_at > now() - interval '7 days') AS sales_recorded_7d
    FROM public.panini_card_serials
)
SELECT (newest_sale_at)::date                                      AS last_supplied_on,
       (CURRENT_DATE - (newest_sale_at)::date)                     AS days_since_last_supplied,
       total_serials,
       priced_serials,
       preserved_fossils,
       round(100.0 * priced_serials / NULLIF(total_serials, 0), 2) AS pct_serials_priced,
       (newest_sale_at > now() - interval '3 days')                AS feed_ok,
       newest_sale_at,
       sales_recorded_7d,
       'nftSalesData (SALES HISTORY tab), since 2026-08-08'::text   AS feed_source
  FROM supply;

COMMENT ON VIEW public.panini_sale_feed_status IS
  'One-row self-measuring status of the Panini serial SALE feed. Since 2026-08-08 realized sales '
  'arrive from nftSalesData (the SALES HISTORY tab the runner clicks) and land on '
  'panini_card_serials.last_sale_usd/last_sale_at; the old getPskuTotalCardsList.brought_at_price '
  'field has been null upstream since 2026-07-29 and is no longer measured here (it made this view '
  'read feed_ok=false for 58 days while the replacement feed was live). feed_ok = a sale was '
  'recorded in the last 3 days. last_sale_at is the latest sale PER SERIAL, so sales_recorded_7d '
  'counts serials, not transactions. ⚠ It covers only serials we have discovered: ~41% of sold '
  'serials were unmatched (sales_missed) on 2026-09-23 because serial discovery reads one 30-row '
  'page per edition — see panini_serial_freshness.';

CREATE OR REPLACE VIEW public.panini_deal_board WITH (security_invoker = on) AS
 SELECT s.sku,
    s.edition_external_id,
    e.player_name,
    e.set_name AS parallel,
    e.tier,
    s.serial_number,
    s.mint_cap,
    s.price_usd AS ask_usd,
    s.best_offer_usd,
    s.last_sale_usd,
    f.fmv_usd AS edition_fmv_usd,
    round((f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one))) AS fmv_usd,
    round((((1)::numeric - (s.price_usd / (f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)))) * (100)::numeric)) AS discount_pct,
    round(((f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)) - s.price_usd)) AS est_profit_usd,
        CASE
            WHEN s.is_number_one THEN 'number 1'::text
            WHEN s.is_perfect_mint THEN 'perfect mint'::text
            WHEN s.is_jersey_mint THEN 'jersey mint'::text
            ELSE NULL::text
        END AS special_flag,
    s.owner,
    s.captured_at AS ask_confirmed_at
   FROM ((panini_card_serials s
     JOIN panini_editions e ON ((e.external_id = s.edition_external_id)))
     JOIN LATERAL ( SELECT fs.fmv_usd,
            fs.confidence
           FROM panini_fmv_snapshots fs
          WHERE (fs.edition_id = e.id)
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON (true))
  WHERE (s.is_listed AND (s.price_usd > (0)::numeric) AND (f.fmv_usd >= (25)::numeric) AND (f.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence])) AND (s.price_usd < ((f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)) * 0.85))
    AND s.captured_at > now() - interval '7 days');

COMMENT ON VIEW public.panini_deal_board IS
  'Serial asks priced >=15% under the edition FMV x serial premium. 2026-09-23: an ask must have been '
  'RE-READ in the last 7 days (captured_at, exposed as ask_confirmed_at) to count as a deal — the walk '
  'reads one 30-row serial page per edition, so older asks are unconfirmed, not live. Before this gate '
  '312 of 696 rows (124 of 230 at >=50% off) were unconfirmed asks with a median age of ~28 days.';

CREATE OR REPLACE VIEW public.panini_special_serials_board WITH (security_invoker = on) AS
 SELECT s.sku,
    s.edition_external_id,
    s.serial_number,
    s.mint_cap,
    s.is_number_one,
    s.is_jersey_mint,
    s.is_perfect_mint,
        CASE
            WHEN s.is_number_one THEN 'number 1'::text
            WHEN s.is_perfect_mint THEN 'perfect mint'::text
            WHEN s.is_jersey_mint THEN 'jersey mint'::text
            ELSE NULL::text
        END AS headline_flag,
    s.nft_type AS all_flags,
    s.price_usd AS serial_ask_usd,
    s.best_offer_usd,
    s.last_sale_usd,
    s.last_sale_at,
    (COALESCE(s.price_usd, (0)::numeric) > (0)::numeric) AS is_listed,
    s.owner,
    e.player_name,
    e.nation,
    e.set_name AS parallel,
    e.tier,
    f.fmv_usd AS edition_fmv_usd,
    panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one) AS premium_mult,
    round((f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one))) AS serial_fmv_usd,
    s.captured_at AS ask_confirmed_at,
    (COALESCE(s.price_usd, (0)::numeric) > (0)::numeric AND s.captured_at <= now() - interval '7 days') AS ask_unconfirmed
   FROM ((panini_card_serials s
     LEFT JOIN panini_editions e ON ((e.external_id = s.edition_external_id)))
     LEFT JOIN LATERAL ( SELECT fs.fmv_usd
           FROM panini_fmv_snapshots fs
          WHERE (fs.edition_id = e.id)
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON (true))
  WHERE s.is_special;

CREATE VIEW public.panini_serial_freshness WITH (security_invoker = on) AS
WITH j AS (
  SELECT s.edition_external_id, s.captured_at, s.price_usd, e.last_seen_at
    FROM public.panini_card_serials s
    JOIN public.panini_editions e ON e.external_id = s.edition_external_id
), per_ed AS (
  SELECT edition_external_id,
         count(*) FILTER (WHERE captured_at >= last_seen_at - interval '2 hours') AS refreshed_in_latest_walk
    FROM j GROUP BY 1
)
SELECT (SELECT count(*) FROM j)                                                                       AS serials_total,
       (SELECT count(*) FROM j WHERE captured_at >= last_seen_at - interval '2 hours')                AS serials_refreshed_in_latest_walk,
       (SELECT count(*) FROM j WHERE captured_at <= now() - interval '7 days')                        AS serials_unconfirmed_7d,
       (SELECT round(100.0 * count(*) FILTER (WHERE captured_at <= now() - interval '7 days') / NULLIF(count(*), 0), 1) FROM j) AS pct_serials_unconfirmed_7d,
       (SELECT count(*) FROM j WHERE price_usd > 0)                                                   AS serial_asks,
       (SELECT count(*) FROM j WHERE price_usd > 0 AND captured_at <= now() - interval '7 days')      AS serial_asks_unconfirmed_7d,
       (SELECT round(100.0 * count(*) FILTER (WHERE captured_at <= now() - interval '7 days') / NULLIF(count(*), 0), 1) FROM j WHERE price_usd > 0) AS pct_serial_asks_unconfirmed_7d,
       (SELECT max(refreshed_in_latest_walk) FROM per_ed)                                             AS max_serials_per_edition_walk,
       (SELECT count(*) FROM per_ed WHERE refreshed_in_latest_walk >= 30)                             AS editions_at_page_cap,
       (SELECT round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM now() - captured_at) / 3600)::numeric, 1) FROM j) AS serial_age_p90_h;

REVOKE ALL ON public.panini_serial_freshness FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.panini_serial_freshness TO service_role;

COMMENT ON VIEW public.panini_serial_freshness IS
  'One-row SERIAL-grain freshness for Panini — the grain panini_coverage_summary (edition-grain) cannot '
  'see. A walk re-reads ONE 30-row getPskuTotalCardsList page per edition (p:1 l:30 sortBy=new), so an '
  'edition can read fresh while most of its serials are weeks old. max_serials_per_edition_walk pinned at '
  '30 is the page cap''s signature; if the runner starts paging it rises above 30. Baseline 2026-09-23 '
  '~20:45 PT: 16.8% of serials and 48% of serial asks unconfirmed in 7 days. Ops-only (service_role).';
