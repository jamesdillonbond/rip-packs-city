-- audit_20260912_pack_summary_ripped_value_known_count
--
-- WHAT IS WRONG. `/dashboard/packs` publishes RIPPED VALUE and NET P&L as
-- measured totals, and on a real wallet they describe a tiny, unstated sample.
-- Measured 2026-09-12 on 0xbd94cade097e50ac:
--   packs in the history list ............ 598   (get_wallet_pack_history.total_count)
--   packs_purchased (the headline tile) .. 133
--   packs the $398 "TOTAL SPENT" covers ..  47   (33 secondary + 14 priced primary)
--   packs_ripped ......................... 503   (computed, and NEVER RENDERED)
--   rips with a pull_value_usd ...........  50   -> the $241.40 "RIPPED VALUE"
-- So NET P&L subtracts a spend sampled over 47 packs from a pull value sampled
-- over 50 of 503 rips: two different, tiny, non-overlapping samples presented as
-- one number. Product-wide the rip side is 312,982 of 3,685,458 rows -- **8.5%** --
-- so this understates RIPPED VALUE by roughly an order of magnitude for everyone,
-- not just this wallet.
--
-- WHY A DB CHANGE. The spend side is already stateable client-side
-- (`packs_purchased - primary_spend_unknown_count`), but the rip side is not:
-- the payload carries `packs_ripped` and `ripped_value_usd` and nothing that says
-- how many of those rips actually HAVE a value. Without that count the UI cannot
-- caption the number honestly or decide to withhold it, so it publishes it.
--
-- WHAT THIS DOES. Adds ONE key, `totals.ripped_value_known_count`. Purely
-- additive: every existing key keeps its name, type and value, so no consumer
-- breaks. Cost is one extra COUNT over rows the same query already scans --
-- `COUNT(pull_value_usd)` beside the existing `COUNT(*)`/`SUM(...)` on
-- public.pack_rips. No new scan, no new join, no new index.
--
-- ⚠ The marker below must keep the function name ON THE SAME LINE as `anon-exec:` —
-- migration-new-function-states-its-anon-exec-decision matches per LINE, so wrapping
-- the name onto the next one reads as no decision at all (cost one red CI, 2026-09-12).
-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of get_wallet_pack_summary, so a revoke here would CHANGE production rather than preserve it
-- Verified live 2026-09-12 before AND after: SECURITY DEFINER, anon EXECUTE false,
-- authenticated EXECUTE false, service_role EXECUTE true.
-- search_path=public and statement_timeout=15s are re-pinned below; dropping
-- either is how this function silently loses its guard.
--
-- REVERT: re-apply the previous body (identical except the three lines marked
--   "2026-09-12" below): drop `v_rips_valued` from DECLARE, restore the
--   four-column SELECT INTO, and delete the 'ripped_value_known_count' key.
--   The UI degrades to hiding the coverage caption; it does not error, because
--   the client reads the key with a null-guard.

CREATE OR REPLACE FUNCTION public.get_wallet_pack_summary(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '15s'
AS $function$
DECLARE
  v_wallet text := lower(coalesce(p_wallet, ''));
  v_purchases_total int; v_sales_total int; v_rips_total int;
  v_rips_valued int;  -- 2026-09-12: rips that actually carry a pull_value_usd
  v_spent numeric; v_proceeds numeric; v_ripped_value numeric;
  v_primary_spent numeric; v_primary_count int; v_primary_unknown int;
  v_secondary_spent numeric; v_secondary_count int;
  v_secondary_proceeds numeric; v_secondary_sold_count int;
  v_currency_breakdown jsonb; v_by_collection jsonb;
  v_first_event timestamptz; v_last_event timestamptz;
BEGIN
  IF v_wallet = '' THEN RETURN jsonb_build_object('error', 'wallet required'); END IF;

  -- Price each row. sale_price is NULL for primary drops (off-chain Dapper);
  -- recover an effective USD value from pack_distributions.metadata->>'retail_price_usd'
  -- via pack_dist_id (AllDay primary_mint — Mint payload carries distId) or
  -- transitively via pack_rips.dist_id (TS primary_withdraw — dist_id only
  -- known after the pack is opened). Rows where neither path yields a price
  -- count toward primary_spend_unknown_count so the UI can show "+ N unpriced
  -- drops" instead of hiding them.
  WITH pp_priced AS (
    SELECT
      pp.collection_id, pp.buyer_address, pp.seller_address,
      pp.sale_price, pp.sale_currency, pp.is_primary_drop,
      CASE WHEN pp.is_primary_drop THEN
        COALESCE(
          (pd_direct.metadata->>'retail_price_usd')::numeric,
          (pd_via_rip.metadata->>'retail_price_usd')::numeric
        )
      ELSE pp.sale_price
      END AS effective_buy_usd,
      (pp.is_primary_drop AND
        COALESCE(
          (pd_direct.metadata->>'retail_price_usd')::numeric,
          (pd_via_rip.metadata->>'retail_price_usd')::numeric
        ) IS NULL
      ) AS is_unknown_primary_buy
    FROM public.pack_purchases pp
    LEFT JOIN public.pack_distributions pd_direct
      ON pd_direct.dist_id = pp.pack_dist_id
     AND pd_direct.collection_id = pp.collection_id
    LEFT JOIN public.pack_rips pr
      ON pr.pack_nft_id = pp.pack_nft_id
     AND pr.collection_id = pp.collection_id
    LEFT JOIN public.pack_distributions pd_via_rip
      ON pd_via_rip.dist_id = pr.dist_id
     AND pd_via_rip.collection_id = pp.collection_id
    WHERE pp.buyer_address = v_wallet OR pp.seller_address = v_wallet
  )
  SELECT
    COUNT(*) FILTER (WHERE buyer_address = v_wallet),
    COUNT(*) FILTER (WHERE seller_address = v_wallet),
    COALESCE(SUM(effective_buy_usd) FILTER (WHERE buyer_address = v_wallet), 0),
    COALESCE(SUM(sale_price) FILTER (WHERE seller_address = v_wallet), 0),
    COUNT(*) FILTER (WHERE buyer_address = v_wallet AND is_primary_drop),
    COALESCE(SUM(effective_buy_usd) FILTER (WHERE buyer_address = v_wallet AND is_primary_drop), 0),
    COUNT(*) FILTER (WHERE buyer_address = v_wallet AND is_unknown_primary_buy),
    COUNT(*) FILTER (WHERE buyer_address = v_wallet AND NOT is_primary_drop),
    COALESCE(SUM(sale_price) FILTER (WHERE buyer_address = v_wallet AND NOT is_primary_drop), 0),
    COUNT(*) FILTER (WHERE seller_address = v_wallet AND NOT is_primary_drop),
    COALESCE(SUM(sale_price) FILTER (WHERE seller_address = v_wallet AND NOT is_primary_drop), 0)
  INTO v_purchases_total, v_sales_total, v_spent, v_proceeds,
       v_primary_count, v_primary_spent, v_primary_unknown,
       v_secondary_count, v_secondary_spent,
       v_secondary_sold_count, v_secondary_proceeds
  FROM pp_priced;

  -- 2026-09-12: COUNT(pull_value_usd) counts NON-NULL only, which is exactly the
  -- coverage figure. Same scan as the COUNT(*) and SUM() beside it.
  SELECT COUNT(*), COUNT(pull_value_usd), COALESCE(SUM(pull_value_usd), 0), MIN(sealed_at), MAX(sealed_at)
  INTO v_rips_total, v_rips_valued, v_ripped_value, v_first_event, v_last_event
  FROM public.pack_rips WHERE opener_address = v_wallet;

  SELECT COALESCE(jsonb_object_agg(sale_currency, jsonb_build_object('purchases', purchases, 'sales', sales, 'spent', spent, 'proceeds', proceeds)), '{}'::jsonb)
  INTO v_currency_breakdown
  FROM (
    SELECT COALESCE(sale_currency, 'UNKNOWN') AS sale_currency,
      COUNT(*) FILTER (WHERE buyer_address = v_wallet)::int AS purchases,
      COUNT(*) FILTER (WHERE seller_address = v_wallet)::int AS sales,
      ROUND(COALESCE(SUM(sale_price) FILTER (WHERE buyer_address = v_wallet), 0)::numeric, 2) AS spent,
      ROUND(COALESCE(SUM(sale_price) FILTER (WHERE seller_address = v_wallet), 0)::numeric, 2) AS proceeds
    FROM public.pack_purchases WHERE buyer_address = v_wallet OR seller_address = v_wallet
    GROUP BY COALESCE(sale_currency, 'UNKNOWN')
  ) cur;

  SELECT COALESCE(jsonb_agg(row_to_json(cb.*)::jsonb ORDER BY cb.activity_total DESC), '[]'::jsonb)
  INTO v_by_collection
  FROM (
    WITH pp_priced AS (
      SELECT
        pp.collection_id, pp.buyer_address, pp.seller_address,
        pp.sale_price, pp.is_primary_drop,
        CASE WHEN pp.is_primary_drop THEN
          COALESCE(
            (pd_direct.metadata->>'retail_price_usd')::numeric,
            (pd_via_rip.metadata->>'retail_price_usd')::numeric
          )
        ELSE pp.sale_price END AS effective_buy_usd,
        (pp.is_primary_drop AND
          COALESCE(
            (pd_direct.metadata->>'retail_price_usd')::numeric,
            (pd_via_rip.metadata->>'retail_price_usd')::numeric
          ) IS NULL
        ) AS is_unknown_primary_buy
      FROM public.pack_purchases pp
      LEFT JOIN public.pack_distributions pd_direct
        ON pd_direct.dist_id = pp.pack_dist_id
       AND pd_direct.collection_id = pp.collection_id
      LEFT JOIN public.pack_rips pr
        ON pr.pack_nft_id = pp.pack_nft_id
       AND pr.collection_id = pp.collection_id
      LEFT JOIN public.pack_distributions pd_via_rip
        ON pd_via_rip.dist_id = pr.dist_id
       AND pd_via_rip.collection_id = pp.collection_id
      WHERE pp.buyer_address = v_wallet OR pp.seller_address = v_wallet
    ),
    purchases AS (
      SELECT collection_id, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE is_primary_drop)::int AS primary_n,
             COUNT(*) FILTER (WHERE NOT is_primary_drop)::int AS secondary_n,
             COUNT(*) FILTER (WHERE is_unknown_primary_buy)::int AS unknown_primary_n,
             COALESCE(SUM(effective_buy_usd), 0)::numeric AS amt
      FROM pp_priced WHERE buyer_address = v_wallet GROUP BY collection_id
    ),
    sales AS (SELECT collection_id, COUNT(*)::int AS n, COALESCE(SUM(sale_price), 0)::numeric AS amt FROM public.pack_purchases WHERE seller_address = v_wallet GROUP BY collection_id),
    rips AS (SELECT collection_id, COUNT(*)::int AS n, COALESCE(SUM(pull_value_usd), 0)::numeric AS amt FROM public.pack_rips WHERE opener_address = v_wallet GROUP BY collection_id),
    all_coll AS (SELECT collection_id FROM purchases UNION SELECT collection_id FROM sales UNION SELECT collection_id FROM rips)
    SELECT c.id AS collection_id, c.slug AS collection_slug, c.name AS collection_name,
      COALESCE(p.n, 0) AS packs_purchased, COALESCE(p.primary_n, 0) AS primary_drops, COALESCE(p.secondary_n, 0) AS secondary_buys,
      COALESCE(p.unknown_primary_n, 0) AS primary_spend_unknown_count,
      COALESCE(s.n, 0) AS packs_sold, COALESCE(r.n, 0) AS packs_ripped,
      ROUND(COALESCE(p.amt, 0)::numeric, 2) AS spent_usd, ROUND(COALESCE(s.amt, 0)::numeric, 2) AS proceeds_usd, ROUND(COALESCE(r.amt, 0)::numeric, 2) AS ripped_value_usd,
      ROUND((COALESCE(s.amt,0) + COALESCE(r.amt,0) - COALESCE(p.amt,0))::numeric, 2) AS net_pl_usd,
      COALESCE(p.n, 0) + COALESCE(s.n, 0) + COALESCE(r.n, 0) AS activity_total
    FROM all_coll a JOIN public.collections c ON c.id = a.collection_id
    LEFT JOIN purchases p ON p.collection_id = a.collection_id
    LEFT JOIN sales s     ON s.collection_id = a.collection_id
    LEFT JOIN rips r      ON r.collection_id = a.collection_id
  ) cb;

  RETURN jsonb_build_object(
    'wallet', v_wallet,
    'totals', jsonb_build_object(
      'packs_purchased',                v_purchases_total,
      'primary_drops',                  v_primary_count,
      'secondary_buys',                 v_secondary_count,
      'packs_sold',                     v_sales_total,
      'packs_ripped',                   v_rips_total,
      'ripped_value_known_count',       v_rips_valued,
      'spent_usd',                      ROUND(COALESCE(v_spent, 0)::numeric, 2),
      'primary_spent_usd',              ROUND(COALESCE(v_primary_spent, 0)::numeric, 2),
      'primary_spend_unknown_count',    v_primary_unknown,
      'secondary_spent_usd',            ROUND(COALESCE(v_secondary_spent, 0)::numeric, 2),
      'sold_proceeds_usd',              ROUND(COALESCE(v_proceeds, 0)::numeric, 2),
      'secondary_proceeds_usd',         ROUND(COALESCE(v_secondary_proceeds, 0)::numeric, 2),
      'ripped_value_usd',               ROUND(COALESCE(v_ripped_value, 0)::numeric, 2),
      'net_pl_usd',                     ROUND((COALESCE(v_proceeds, 0) + COALESCE(v_ripped_value, 0) - COALESCE(v_spent, 0))::numeric, 2),
      'first_event_at',                 v_first_event,
      'last_event_at',                  v_last_event
    ),
    'by_currency', v_currency_breakdown,
    'by_collection', v_by_collection,
    'computed_at', now(),
    'note', 'pack_purchases captures peer-to-peer secondary pack sales (event_kind=secondary_sale) plus primary Studio drops (event_kind=primary_withdraw for Top Shot, primary_mint for AllDay). Primary drop sale_price is NULL on-chain (off-chain Dapper); primary_spent_usd recovers retail pricing via pack_distributions.metadata->>retail_price_usd. primary_spend_unknown_count counts primary buys with no recoverable retail price. ripped_value_known_count is how many of packs_ripped actually carry a pull_value_usd -- ripped_value_usd is the sum over THOSE rips only.'
  );
END;
$function$;
