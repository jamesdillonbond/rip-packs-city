-- 2026-11-14 (~6:50 PM PT, Claude Code cloud). Trevor: "Keep probing, looking at other saved wallets too ... Take
-- action on things you're 100% certain on and have the facts to back it."
--
-- WHY: of the 56 saved wallets only 3 have an acquisition row for >= 90% of their held Top Shot moments (200,182
-- held Top Shot moments have none). Every sales -> acquisition lane looks back 14 days only (pinnacle, the
-- All Day / Golazos / UFC multicollection cron), and Top Shot has no such lane at all, so a wallet's history before
-- it was saved never lands. The facts that settle most of it are already in our own tables.
--
-- WHAT this function writes, for ONE wallet and ONE collection, and only for moments the wallet HOLDS now
-- (wallet_moments_cache) — each arm is a fact, never a guess:
--   A. BUY: no acquisition row, and the LATEST sale of that moment in that collection anywhere is a sale TO this
--      wallet (buyer = wallet, seller <> wallet, price > 0, a dollar-pegged currency). The current holding came from
--      that purchase. Inserted as marketplace (offer_accepted when the sale was an offer fill) at the sale price,
--      confidence 'verified'. Measured agreement where both already existed (0xbd94, 4,825 moments): 99.75% to the
--      cent ($53,846 vs $53,836).
--   B. UNKNOWN -> BUY: an existing acquisition_method = 'unknown' row with no price, under the same proof as A ->
--      marketplace at the sale price.
--   C. PULL: no acquisition row, this wallet is the recorded OPENER of the pack that yielded it (pack_open_pulls /
--      allday_pack_pull / pinnacle_pack_opens), and the moment has never sold anywhere -> pack_pull ($0 by the
--      pack-cost-lives-on-the-pack rule and trigger).
-- Pinnacle reads pinnacle_sales / pinnacle_pack_opens instead of sales / pack_open_pulls.
-- Everything it writes is recorded in flowty_archive.acq_own_history_backfill_20261114 (arm, row id, prior row).
-- Revert (all of it):
--   DELETE FROM moment_acquisitions m USING flowty_archive.acq_own_history_backfill_20261114 r
--     WHERE m.id = r.acq_id AND r.arm IN ('A_buy','C_pull');
--   UPDATE moment_acquisitions m SET acquisition_method = (r.prior->>'acquisition_method'), buy_price = NULL,
--     seller_address = r.prior->>'seller_address', acquisition_confidence = r.prior->>'acquisition_confidence',
--     source = r.prior->>'source', acquired_date = (r.prior->>'acquired_date')::timestamptz
--     FROM flowty_archive.acq_own_history_backfill_20261114 r WHERE m.id = r.acq_id AND r.arm = 'B_unknown';
--   DROP FUNCTION public.backfill_acq_own_history_20261114(text, uuid);

CREATE TABLE IF NOT EXISTS flowty_archive.acq_own_history_backfill_20261114 (
  acq_id uuid NOT NULL,
  wallet text NOT NULL,
  collection_id uuid NOT NULL,
  nft_id text NOT NULL,
  arm text NOT NULL,
  price numeric,
  prior jsonb,
  written_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON flowty_archive.acq_own_history_backfill_20261114 FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.backfill_acq_own_history_20261114(p_wallet text, p_collection_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_pin uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_ad  uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  n_a int := 0; n_b int := 0; n_c int := 0; usd_a numeric := 0; usd_b numeric := 0;
BEGIN
  IF p_wallet IS NULL OR p_collection_id IS NULL THEN RAISE EXCEPTION 'wallet and collection required'; END IF;

  -- the latest sale of every held moment, one row each (sales / pinnacle_sales)
  CREATE TEMP TABLE _held ON COMMIT DROP AS
  SELECT w.moment_id AS nft_id FROM wallet_moments_cache w
  WHERE w.wallet_address = p_wallet AND w.collection_id = p_collection_id;

  CREATE TEMP TABLE _last ON COMMIT DROP AS
  SELECT h.nft_id, l.buyer, l.seller, l.price, l.sold_at, l.tx, l.is_offer, l.ok_ccy
  FROM _held h
  JOIN LATERAL (
    SELECT s.buyer_address AS buyer, s.seller_address AS seller, s.price_usd AS price, s.sold_at,
           COALESCE(s.transaction_hash, 'own_sale:' || s.id::text) AS tx,
           (s.offer_id IS NOT NULL OR s.source = 'offer_fill') AS is_offer,
           (COALESCE(s.currency, 'USD') IN ('USD', 'DUC', 'USDC')) AS ok_ccy
    FROM sales s
    WHERE p_collection_id <> v_pin AND s.nft_id = h.nft_id AND s.collection_id = p_collection_id
    UNION ALL
    SELECT ps.buyer_address, ps.seller_address, ps.sale_price_usd, ps.sold_at,
           COALESCE(NULLIF(split_part(ps.id::text, '_', 1), ''), 'own_sale:' || ps.id::text), false, true
    FROM pinnacle_sales ps
    WHERE p_collection_id = v_pin AND ps.nft_id = h.nft_id
    ORDER BY 4 DESC
    LIMIT 1
  ) l ON true;

  -- A. buys with no row
  WITH ins AS (
    INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, acquired_date, acquired_type, seller_address,
      transaction_hash, source, collection_id, acquisition_method, acquisition_confidence)
    SELECT l.nft_id, p_wallet, l.price, l.sold_at, 1, l.seller, l.tx, 'own_history_backfill_20261114', p_collection_id,
           CASE WHEN l.is_offer THEN 'offer_accepted' ELSE 'marketplace' END, 'verified'
    FROM _last l
    WHERE l.buyer = p_wallet AND l.seller IS DISTINCT FROM p_wallet AND l.price > 0 AND l.ok_ccy
      AND NOT EXISTS (SELECT 1 FROM moment_acquisitions ma WHERE ma.nft_id = l.nft_id AND ma.wallet = p_wallet
                        AND ma.collection_id = p_collection_id)
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING id, nft_id, buy_price
  ), rec AS (
    INSERT INTO flowty_archive.acq_own_history_backfill_20261114 (acq_id, wallet, collection_id, nft_id, arm, price)
    SELECT id, p_wallet, p_collection_id, nft_id, 'A_buy', buy_price FROM ins RETURNING price
  )
  SELECT count(*), COALESCE(sum(price), 0) INTO n_a, usd_a FROM rec;

  -- B. unknown, unpriced rows proven by the same sale
  WITH tgt AS (
    SELECT ma.id, ma.nft_id, to_jsonb(ma) AS prior, l.price, l.seller, l.sold_at, l.is_offer
    FROM moment_acquisitions ma JOIN _last l ON l.nft_id = ma.nft_id
    WHERE ma.wallet = p_wallet AND ma.collection_id = p_collection_id
      AND ma.acquisition_method = 'unknown' AND ma.buy_price IS NULL
      AND l.buyer = p_wallet AND l.seller IS DISTINCT FROM p_wallet AND l.price > 0 AND l.ok_ccy
      AND (SELECT count(*) FROM moment_acquisitions m2 WHERE m2.nft_id = ma.nft_id AND m2.wallet = p_wallet
             AND m2.collection_id = p_collection_id) = 1
  ), upd AS (
    UPDATE moment_acquisitions m
    SET acquisition_method = CASE WHEN t.is_offer THEN 'offer_accepted' ELSE 'marketplace' END,
        buy_price = t.price, seller_address = t.seller, acquired_date = t.sold_at,
        acquisition_confidence = 'verified', source = 'own_history_backfill_20261114'
    FROM tgt t WHERE m.id = t.id
    RETURNING m.id
  ), rec AS (
    INSERT INTO flowty_archive.acq_own_history_backfill_20261114 (acq_id, wallet, collection_id, nft_id, arm, price, prior)
    SELECT t.id, p_wallet, p_collection_id, t.nft_id, 'B_unknown', t.price, t.prior FROM tgt t JOIN upd u ON u.id = t.id
    RETURNING price
  )
  SELECT count(*), COALESCE(sum(price), 0) INTO n_b, usd_b FROM rec;

  -- C. pulls this wallet opened, never sold since
  WITH pulls AS (
    SELECT h.nft_id FROM _held h
    WHERE NOT EXISTS (SELECT 1 FROM _last l WHERE l.nft_id = h.nft_id)
      AND NOT EXISTS (SELECT 1 FROM moment_acquisitions ma WHERE ma.nft_id = h.nft_id AND ma.wallet = p_wallet
                        AND ma.collection_id = p_collection_id)
      AND (
        (p_collection_id <> v_pin AND EXISTS (SELECT 1 FROM pack_open_pulls o WHERE o.collection_id = p_collection_id
            AND o.nft_id = h.nft_id AND o.opener_address = p_wallet))
        OR (p_collection_id = v_ad AND EXISTS (SELECT 1 FROM allday_pack_pull a WHERE a.moment_nft_id = h.nft_id
            AND a.opener_address = p_wallet))
        OR (p_collection_id = v_pin AND EXISTS (SELECT 1 FROM pinnacle_pack_opens po WHERE po.opener_address = p_wallet
            AND h.nft_id = ANY (po.nft_ids)))
      )
  ), ins AS (
    INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, acquired_type, transaction_hash, source, collection_id,
      acquisition_method, acquisition_confidence)
    SELECT nft_id, p_wallet, 0, 1, 'own_pull:' || nft_id, 'own_history_backfill_20261114', p_collection_id,
           'pack_pull', 'verified'
    FROM pulls
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING id, nft_id
  ), rec AS (
    INSERT INTO flowty_archive.acq_own_history_backfill_20261114 (acq_id, wallet, collection_id, nft_id, arm, price)
    SELECT id, p_wallet, p_collection_id, nft_id, 'C_pull', 0 FROM ins RETURNING 1
  )
  SELECT count(*) INTO n_c FROM rec;

  DROP TABLE IF EXISTS _last; DROP TABLE IF EXISTS _held;
  RETURN jsonb_build_object('wallet', p_wallet, 'collection_id', p_collection_id,
    'a_buys', n_a, 'a_usd', round(usd_a, 2), 'b_unknown_to_buy', n_b, 'b_usd', round(usd_b, 2), 'c_pulls', n_c);
END
$fn$;
REVOKE ALL ON FUNCTION public.backfill_acq_own_history_20261114(text, uuid) FROM PUBLIC, anon, authenticated;
