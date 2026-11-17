-- Snapshot migration: the two Pinnacle ACQUISITION backfills.
--
--   public.backfill_pinnacle_acquisitions(integer)       -- marketplace purchases
--   public.backfill_pinnacle_mint_acquisitions(integer)  -- mints
--
-- Both were applied to prod via the Supabase MCP with no committed migration
-- file, which made them UNPINNABLE — the DB-invariant drift guard has nothing to
-- compare a test copy against, and `npm run db:pins:check` has no committed body
-- to diff live `prosrc` against. This commits the CURRENT LIVE definitions
-- verbatim (pg_get_functiondef, 2026-08-16):
--   backfill_pinnacle_acquisitions       md5 8f83d9170e3e025d0b271ae5880589b7
--   backfill_pinnacle_mint_acquisitions  md5 551b9c90e4659c01514dddfe0673ffef
-- Applying it is a no-op against prod (byte-identical to what already runs).
--
-- WHY THESE TWO, OUT OF THE 14 UNPINNED SCHEDULED WRITERS. They are the pair
-- that writes `moment_acquisitions` — the COST BASIS table. Every P&L figure a
-- Pinnacle collector sees on their own moments is derived from these rows
-- (`resolveMomentPnlBasis()`, the Cost and P&L columns in
-- CollectionMomentTable). A defect here does not throw; it shows a collector the
-- wrong profit on their own collection, which is the failure mode this repo
-- keeps paying for.
--
-- ⚠ THE TWO ARE DELIBERATELY ASYMMETRIC, AND THE ASYMMETRY IS THE INVARIANT:
--
--   • The MINT path writes NO buy_price at all. A mint has no purchase price,
--     and defaulting it to 0 would render as a 100%-profit moment forever. The
--     column is simply omitted from its INSERT column list.
--   • The MINT path is additionally gated on
--     `NOT EXISTS (SELECT 1 FROM moment_acquisitions a WHERE a.nft_id = m.nft_id)`
--     — scoped on nft_id ALONE, not on (nft_id, wallet). That is intentional: a
--     mint is the FIRST acquisition of a moment, so once ANY acquisition row
--     exists for that nft_id the mint must not be inserted retroactively behind
--     it. Narrowing this to (nft_id, wallet) would let a mint row appear beneath
--     a later marketplace purchase by a different wallet.
--   • The MARKETPLACE path has no such guard and relies on
--     `ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING`, because a
--     moment legitimately changes hands many times — one row per (wallet, tx).
--
-- Both stamp `acquisition_confidence = 'verified'`, which is what lets downstream
-- surfaces show the figure without a caveat. Neither may ever widen that to a
-- guessed row.
--
-- REVERT: these are snapshots of what is already live, so reverting the FILE
-- changes nothing in prod. To remove the functions themselves:
--   DROP FUNCTION public.backfill_pinnacle_acquisitions(integer);
--   DROP FUNCTION public.backfill_pinnacle_mint_acquisitions(integer);
-- (which would also require unscheduling pg_cron `rpc-backfill-pinnacle-acquisitions`
-- at `17 */6 * * *` and `rpc-backfill-pinnacle-mint-acquisitions` at `19 * * * *`).

CREATE OR REPLACE FUNCTION public.backfill_pinnacle_acquisitions(p_limit integer DEFAULT 50000)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_inserted int := 0;
  v_pin uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
BEGIN
  WITH candidates AS (
    SELECT ps.nft_id,
           wmc.wallet_address AS wallet,
           ps.sale_price_usd  AS buy_price,
           ps.sold_at         AS acquired_date,
           ps.seller_address,
           COALESCE(NULLIF(split_part(ps.id, '_', 1), ''), 'pinnacle_backfill:' || ps.nft_id) AS tx_hash
    FROM wallet_moments_cache wmc
    JOIN pinnacle_sales ps
      ON ps.nft_id = wmc.moment_id
     AND ps.buyer_address = wmc.wallet_address
    WHERE wmc.collection_id = v_pin
      AND ps.sale_price_usd > 0
    LIMIT p_limit
  ),
  ins AS (
    INSERT INTO moment_acquisitions (
      nft_id, wallet, buy_price, acquired_date, acquired_type,
      acquisition_method, acquisition_confidence,
      seller_address, transaction_hash, source, collection_id
    )
    SELECT
      nft_id, wallet, buy_price, acquired_date, 1,
      'marketplace', 'verified',
      seller_address, tx_hash,
      'pinnacle_sales_join_wmc', v_pin
    FROM candidates
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) FROM ins INTO v_inserted;

  RETURN json_build_object('collection', 'disney_pinnacle', 'inserted', v_inserted);
END;
$function$;

CREATE OR REPLACE FUNCTION public.backfill_pinnacle_mint_acquisitions(p_limit integer DEFAULT 50000)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_inserted int := 0;
  v_pin uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
BEGIN
  WITH candidates AS (
    SELECT m.nft_id,
           wmc.wallet_address AS wallet,
           m.minted_at        AS acquired_date,
           COALESCE(NULLIF(m.tx_hash, ''), 'pinnacle_mint:' || m.nft_id) AS tx_hash
    FROM public.pinnacle_mint_events m
    JOIN public.wallet_moments_cache wmc
      ON wmc.moment_id = m.nft_id
     AND wmc.collection_id = v_pin
     AND lower(wmc.wallet_address) = lower(m.to_wallet)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.moment_acquisitions a WHERE a.nft_id = m.nft_id
    )
    LIMIT p_limit
  ),
  ins AS (
    INSERT INTO public.moment_acquisitions (
      nft_id, wallet, acquired_date, acquired_type,
      acquisition_method, acquisition_confidence,
      transaction_hash, source, collection_id
    )
    SELECT
      nft_id, wallet, acquired_date, 1,
      'mint', 'verified',
      tx_hash, 'pinnacle_mints', v_pin
    FROM candidates
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) FROM ins INTO v_inserted;

  RETURN json_build_object('collection', 'disney_pinnacle', 'inserted', v_inserted);
END;
$function$;
