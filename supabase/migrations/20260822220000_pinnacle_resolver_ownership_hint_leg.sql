-- Pinnacle resolver, part 4: 673 unresolved SALES have a known owner we never use.
--
-- 🚨 FIRST, A CORRECTION TO PART 3 (20260822213000). Its header warned "expect
-- sales to drain slightly slower per run" once trades joined the batch. **That is
-- measured and WRONG.** The resolver's sales leg requires `buyer_address IS NOT
-- NULL`, and that pool is essentially EMPTY:
--
--     unresolved sales visible to the sales leg .............     5
--     unresolved sales in total .............................   678
--     unresolved trade nft_ids ..............................  4,215
--
-- The sales leg was offering 5 of its 50 slots and the rest went to `wmc`, so
-- trades displaced wmc, not sales. Adding trades cost sales resolution NOTHING.
--
-- ⚠ AND THE GAP THAT LOOKING REVEALED: **680 unresolved sales carry a NULL
-- `buyer_address`** — the sales indexer sets `buyer_address = commissionReceiver
-- ?? null`, so any sale without a commission receiver is invisible to the
-- resolver BY CONSTRUCTION. **673 of those 680 (99%) have a known current owner
-- in `pinnacle_ownership_snapshots`.** The hint existed the whole time in a table
-- nothing joined to. Same shape as part 3: a population defined by where the
-- work used to come from.
--
-- This adds a fourth leg using that owner as the hint, and — because a resolved
-- SALE feeds FMV while a resolved TRADE does not — orders the legs so pricing
-- wins the scarce slots:
--
--     sales (buyer hint)  →  sales (ownership hint)  →  trades  →  wmc
--
-- ⚠ A STALE HINT IS ACCEPTABLE AND ALREADY THE NORM. `pinnacle_ownership_snapshots`
-- holds the last Deposit-derived owner, so a Pin that moved since our last scan
-- points at the wrong account and the Cadence read finds nothing. That costs one
-- wasted script call and the row stays in the queue — exactly the risk
-- `buyer_address` already carries (a buyer can resell). It is not a correctness
-- problem: a miss resolves nothing rather than resolving something wrong.
--
-- ⚠ NOT DEDUPED AGAINST `pinnacle_nft_map` on purpose for the sales legs — a sale
-- row can be unresolved while the map DOES cover the nft (that is the promotion
-- step's job, `backfill_pinnacle_sale_editions`, not the resolver's). The trade
-- and wmc legs keep their map checks, which is the behaviour they already had.
--
-- REVERT: restore the three-leg body from 20260822213000_*.sql.

CREATE OR REPLACE FUNCTION public.pinnacle_get_unresolved_batch_v2(p_limit integer DEFAULT 50)
 RETURNS TABLE(nft_id text, source text, hint_address text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH
  sales_targets AS (
    SELECT DISTINCT ON (ps.nft_id)
      ps.nft_id,
      'sales'::text AS source,
      ps.buyer_address AS hint_address,
      ps.sold_at
    FROM pinnacle_sales ps
    WHERE ps.edition_id IS NULL
      AND ps.nft_id IS NOT NULL
      AND ps.buyer_address IS NOT NULL
    ORDER BY ps.nft_id, ps.sold_at DESC
    LIMIT p_limit
  ),
  sales_owner_targets AS (
    SELECT DISTINCT ON (ps.nft_id)
      ps.nft_id,
      'sales_owner'::text AS source,
      o.owner AS hint_address,
      ps.sold_at
    FROM pinnacle_sales ps
    JOIN pinnacle_ownership_snapshots o ON o.nft_id = ps.nft_id
    WHERE ps.edition_id IS NULL
      AND ps.nft_id IS NOT NULL
      AND ps.buyer_address IS NULL
      AND o.owner IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM sales_targets st WHERE st.nft_id = ps.nft_id)
    ORDER BY ps.nft_id, ps.sold_at DESC
    LIMIT p_limit
  ),
  trade_targets AS (
    SELECT DISTINCT ON (t.nft_id)
      t.nft_id,
      'trade'::text AS source,
      t.to_wallet AS hint_address,
      t.traded_at
    FROM pinnacle_trade_events t
    WHERE t.edition_id IS NULL
      AND t.nft_id IS NOT NULL
      AND t.to_wallet IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pinnacle_nft_map m WHERE m.nft_id = t.nft_id)
      AND NOT EXISTS (SELECT 1 FROM sales_targets st WHERE st.nft_id = t.nft_id)
      AND NOT EXISTS (SELECT 1 FROM sales_owner_targets so WHERE so.nft_id = t.nft_id)
    ORDER BY t.nft_id, t.traded_at DESC
    LIMIT p_limit
  ),
  wmc_targets AS (
    SELECT
      wmc.moment_id AS nft_id,
      'wmc'::text AS source,
      wmc.wallet_address AS hint_address
    FROM wallet_moments_cache wmc
    WHERE wmc.collection_id = (SELECT id FROM collections WHERE slug = 'disney_pinnacle')
      AND NOT EXISTS (SELECT 1 FROM pinnacle_nft_map m WHERE m.nft_id = wmc.moment_id)
      AND NOT EXISTS (SELECT 1 FROM sales_targets st WHERE st.nft_id = wmc.moment_id)
      AND NOT EXISTS (SELECT 1 FROM sales_owner_targets so WHERE so.nft_id = wmc.moment_id)
      AND NOT EXISTS (SELECT 1 FROM trade_targets tt WHERE tt.nft_id = wmc.moment_id)
    LIMIT p_limit
  )
  -- ⚠ ORDER IS THE PRIORITY. UNION ALL preserves it and the outer LIMIT truncates
  -- from the bottom, so a resolved SALE (which feeds FMV, the roadmap's headline
  -- metric) always outranks a resolved TRADE (which does not).
  SELECT nft_id, source, hint_address FROM sales_targets
  UNION ALL
  SELECT nft_id, source, hint_address FROM sales_owner_targets
  UNION ALL
  SELECT nft_id, source, hint_address FROM trade_targets
  UNION ALL
  SELECT nft_id, source, hint_address FROM wmc_targets
  LIMIT p_limit;
$function$;
-- anon-exec: none -- CREATE OR REPLACE over an existing pinnacle_get_unresolved_batch_v2 preserves its
-- ACL, so a REVOKE here would be a live privilege change rather than the no-op it appears to be.
