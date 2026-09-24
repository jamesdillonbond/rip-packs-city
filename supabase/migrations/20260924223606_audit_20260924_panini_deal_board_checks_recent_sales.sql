-- audit_20260924_panini_deal_board_checks_recent_sales
-- The deal board compared asks to the published FMV, which is a LIFETIME average and runs high in a
-- falling market (panini_fmv_backtest: median ratio 1.1-1.14). Measured 2026-09-24 3:35 PM PT: of 72
-- deals on editions WITH non-special sales in the last 30 days, 53 (74%) were not >=15% under the median
-- of those sales; published FMV on them ran a median 1.81x recent sales. Deals are selected exactly where
-- FMV is most overstated. Adds a second gate (ask also >=15% under the recent-sales median x premium,
-- where one exists), plus recent_sales_median_usd / recent_sales_n / deal_basis. 385 -> 332 rows
-- (19 with recent-sales support, 313 fmv_only_no_recent_sales). Unpublished board.
-- Revert: re-apply the panini_deal_board body from 20260924035329.

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
    s.captured_at AS ask_confirmed_at,
    r.med AS recent_sales_median_usd,
    COALESCE(r.n, 0) AS recent_sales_n,
    CASE WHEN r.med IS NOT NULL THEN 'fmv_and_recent_sales' ELSE 'fmv_only_no_recent_sales' END AS deal_basis
   FROM (((panini_card_serials s
     JOIN panini_editions e ON ((e.external_id = s.edition_external_id)))
     JOIN LATERAL ( SELECT fs.fmv_usd,
            fs.confidence
           FROM panini_fmv_snapshots fs
          WHERE (fs.edition_id = e.id)
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON (true))
     LEFT JOIN LATERAL ( SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY z.p)::numeric AS med, count(*)::int AS n
           FROM ( SELECT cs.last_sale_usd AS p
                   FROM panini_card_serials cs
                  WHERE cs.edition_external_id = e.external_id
                    AND cs.last_sale_usd > 0
                    AND cs.last_sale_at > now() - interval '30 days'
                    AND NOT COALESCE(cs.is_special, false)
                  ORDER BY cs.last_sale_at DESC
                 LIMIT 3) z
         HAVING count(*) > 0) r ON (true))
  WHERE (s.is_listed AND (s.price_usd > (0)::numeric) AND (f.fmv_usd >= (25)::numeric) AND (f.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence])) AND (s.price_usd < ((f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)) * 0.85)) AND (s.captured_at > (now() - '7 days'::interval))
    AND (r.med IS NULL OR s.price_usd < r.med * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one) * 0.85));

COMMENT ON VIEW public.panini_deal_board IS
  'Serial asks priced >=15% under the edition FMV x serial premium. Gates: (1) 2026-09-23 the ask must have been re-read in 7 days (ask_confirmed_at); (2) 2026-09-24 where the edition HAS non-special sales in the last 30 days, the ask must ALSO be >=15% under the median of its last <=3 (recent_sales_median_usd x premium). Measured 09-24: of 72 deals on editions with recent sales, 53 (74%) failed that test; the published lifetime-average FMV on them ran a median 1.81x recent sales, so the board was mostly an artifact of FMV overstatement. deal_basis = fmv_only_no_recent_sales marks deals with no recent market evidence at all. Unpublished (no app reader).';
