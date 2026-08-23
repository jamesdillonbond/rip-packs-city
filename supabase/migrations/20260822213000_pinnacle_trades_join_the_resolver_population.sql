-- Pinnacle TRADE lane, part 3: let traded Pins actually resolve to an edition.
--
-- 🚨 A CLAIM IN PART 1 (20260822180000) WAS FALSE AND THIS CORRECTS IT. That
-- migration said `pinnacle_trade_events.edition_id` would "backfill later exactly
-- as pinnacle_sales.edition_id does". It would NOT have. Measured 2026-08-22:
--
--     pinnacle_sales (on-chain, 3d)   1,258 rows   68.9% resolved
--     pinnacle_trade_events           6,317 rows    7.8% resolved
--
-- ⚠ AND THE CONTROL SAYS THE JOIN IS FINE: **zero** trade rows are unresolved
-- while their nft_id sits in pinnacle_nft_map. The resolver simply never looks at
-- them. `pinnacle_get_unresolved_batch_v2` derives its candidates from
-- `pinnacle_sales` and `wallet_moments_cache` ONLY, so a Pin that has only ever
-- TRADED is outside the resolver's population BY CONSTRUCTION — the same shape as
-- every other coverage gap in this repo: a population defined by where the work
-- used to come from, silently excluding a new source.
--
-- Without this, 92% of trade rows stay NULL forever, not "until the map grows".
--
-- TWO CHANGES, mirroring the sales path exactly:
--
--   1. `pinnacle_get_unresolved_batch_v2` gains a `trade_targets` leg. Hint
--      address is `to_wallet` — the CURRENT holder, which is what the resolver's
--      Cadence script needs to read the NFT. (For a sale the hint is
--      `buyer_address`, the same role.)
--      ⚠ The leg is deduped against BOTH prior legs, exactly as `wmc_targets`
--      already dedupes against `sales_targets`, so one Pin cannot consume three
--      slots of a limited batch.
--      ⚠ The overall `LIMIT p_limit` is unchanged, so this does NOT increase the
--      resolver's per-run cost — it changes the MIX.
--      🚨 THIS LINE ORIGINALLY WARNED "expect sales to drain slightly slower per
--      run". MEASURED IMMEDIATELY AFTER APPLYING, THAT IS WRONG and the
--      correction is left here rather than silently deleted: the sales leg
--      requires `buyer_address IS NOT NULL` and that pool held just **5** rows
--      against 4,215 unresolved trades, so the sales leg was already offering 5
--      of its 50 slots. Trades displaced `wmc`, NOT sales. See
--      20260822220000_*.sql, which acts on what looking for the cost revealed:
--      680 unresolved sales carry a NULL buyer and 673 of them have a known
--      owner nothing was joining to.
--
--   2. New `backfill_pinnacle_trade_editions()`, the exact analogue of
--      `backfill_pinnacle_sale_editions()`. Promoting a resolved map entry into
--      the trade table is a SEPARATE step from resolving it, and the sales
--      version is called by the resolver edge function. This one is scheduled on
--      its own pg_cron entry instead: it needs no edge-function deploy, and it
--      keeps the trade lane's liveness independent of the resolver's.
--
-- ⚠ Both guard on `EXISTS (... pinnacle_editions pe WHERE pe.id = m.edition_key)`
-- like the sales version: a map entry pointing at an edition we do not carry must
-- NOT be written, or the trade row would reference a dangling key.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-backfill-pinnacle-trade-editions');
--   DROP FUNCTION public.backfill_pinnacle_trade_editions();
--   -- and restore the two-leg body of pinnacle_get_unresolved_batch_v2 from
--   -- whichever migration last defined it before this one.

-- ⚠ THE INDEX IS NOT OPTIONAL, and it is why this is here rather than left to a
-- follow-up. Both objects below filter on `edition_id IS NULL`, and part 1's
-- index on edition_id is PARTIAL `WHERE edition_id IS NOT NULL` — the exact
-- complement, so it cannot serve either query. Unindexed, the resolver's
-- DISTINCT ON would sort every unresolved row (heading for hundreds of
-- thousands) on an instance where disk-IO saturation is the dominant problem,
-- every 30 minutes. With it the DISTINCT ON is an index scan the LIMIT stops
-- early, and the promotion UPDATE seeks instead of scanning.
-- ⚠ It also SHRINKS as the lane succeeds: a resolved row leaves the partial
-- index, so the thing that would make it expensive is the thing that empties it.
CREATE INDEX IF NOT EXISTS pinnacle_trade_events_unresolved_idx
  ON public.pinnacle_trade_events (nft_id, traded_at DESC)
  WHERE edition_id IS NULL;

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
      AND NOT EXISTS (SELECT 1 FROM trade_targets tt WHERE tt.nft_id = wmc.moment_id)
    LIMIT p_limit
  )
  SELECT nft_id, source, hint_address FROM sales_targets
  UNION ALL
  SELECT nft_id, source, hint_address FROM trade_targets
  UNION ALL
  SELECT nft_id, source, hint_address FROM wmc_targets
  LIMIT p_limit;
$function$;

CREATE OR REPLACE FUNCTION public.backfill_pinnacle_trade_editions()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated integer;
  v_skipped integer;
BEGIN
  UPDATE pinnacle_trade_events t
  SET edition_id = m.edition_key
  FROM pinnacle_nft_map m
  WHERE t.nft_id = m.nft_id
    AND t.edition_id IS NULL
    AND EXISTS (SELECT 1 FROM pinnacle_editions pe WHERE pe.id = m.edition_key);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Counted, not silently dropped: a map entry whose edition we do not carry.
  SELECT count(*) INTO v_skipped
  FROM pinnacle_trade_events t
  JOIN pinnacle_nft_map m ON m.nft_id = t.nft_id
  WHERE t.edition_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM pinnacle_editions pe WHERE pe.id = m.edition_key);

  RETURN jsonb_build_object(
    'updated', v_updated,
    'skipped_missing_edition', v_skipped,
    'still_null', (SELECT count(*) FROM pinnacle_trade_events WHERE edition_id IS NULL)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.backfill_pinnacle_trade_editions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_pinnacle_trade_editions() TO postgres, service_role;
-- anon-exec: revoked above for backfill_pinnacle_trade_editions. pinnacle_get_unresolved_batch_v2 is
-- CREATE OR REPLACE over an existing function, which does NOT reset its ACL, so a revoke there would be
-- a live privilege change rather than the no-op it looks like — its existing grants are left untouched.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-backfill-pinnacle-trade-editions') THEN
    PERFORM cron.unschedule('rpc-backfill-pinnacle-trade-editions');
  END IF;
END $$;

SET LOCAL ROLE cron_heavy;
SELECT cron.schedule(
  'rpc-backfill-pinnacle-trade-editions',
  '41 * * * *',
  'SELECT public.backfill_pinnacle_trade_editions()'
);
RESET ROLE;
