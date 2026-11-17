-- audit_20261116_fill_acquisitions_for_arriving_moments
--
-- 2026-11-16 ~8:45 PM PT (Claude Code cloud; Trevor: "Do it all" — make a just-arrived moment show its real
-- acquisition date and price instead of a first-seen placeholder).
--
-- WHY. /api/cache-refresh notices new moments in a wallet and wrote an acquisition_method='unknown' row
-- for each, dated NOW (when WE first saw it) with no price. Walter Clayton Jr. #34 and Frieda Bühner #46
-- (0xbd94, 11-16) were marketplace buys at 6:13 / 6:59 PM PT, both already in `sales`, yet the binder
-- showed a blank Paid and a first-seen Acquired date until the saved-wallet fill (jobid 886, every 2 h,
-- SAVED wallets only) upgraded them.
--
-- WHAT. fill_acquisitions_for_moments(wallet, collection, nft_ids) runs the SAME three fact-only arms as
-- backfill_acq_own_history_20261114 (20261115031000_…), scoped to the ids passed (≤ 500):
--   A. BUY        — no row, and the latest sale of that moment in that collection is TO this wallet
--                   (seller ≠ wallet, price > 0, dollar-pegged) → marketplace / offer_accepted at sale price + time.
--   B. UNKNOWN→BUY — the single existing row is 'unknown' with no price, same proof → upgraded in place.
--   C. PULL       — no row, never sold anywhere, and this wallet is the recorded opener of the pack → pack_pull $0.
-- It returns the ids it wrote, so the caller writes an 'unknown' placeholder only for what it could NOT prove.
-- Rows are tagged source = 'arrival_fill' and recorded in flowty_archive.acq_own_history_backfill_20261114
-- (arm, prior row) like the parent function, so the same revert works.
--
-- COST. Every read is keyed by (nft_id, collection_id) for ≤ 500 ids — the per-moment shape of the parent's
-- LATERAL, without its whole-wallet `_held` scan. No temp tables (it runs via PostgREST).
--
-- anon-exec: revoked (fill_acquisitions_for_moments) — writes moment_acquisitions; service_role only (cache-refresh's admin client).
--
-- REVERT:
--   DELETE FROM moment_acquisitions m USING flowty_archive.acq_own_history_backfill_20261114 r
--     WHERE m.id = r.acq_id AND r.arm IN ('A_buy_arrival','C_pull_arrival');
--   UPDATE moment_acquisitions m SET acquisition_method = r.prior->>'acquisition_method', buy_price = NULL,
--     seller_address = r.prior->>'seller_address', acquisition_confidence = r.prior->>'acquisition_confidence',
--     source = r.prior->>'source', acquired_date = (r.prior->>'acquired_date')::timestamptz
--     FROM flowty_archive.acq_own_history_backfill_20261114 r WHERE m.id = r.acq_id AND r.arm = 'B_unknown_arrival';
--   DROP FUNCTION public.fill_acquisitions_for_moments(text, uuid, text[]);

CREATE OR REPLACE FUNCTION public.fill_acquisitions_for_moments(p_wallet text, p_collection_id uuid, p_nft_ids text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '20s'
AS $fn$
DECLARE
  v_pin uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_ad  uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_a text[] := '{}'; v_b text[] := '{}'; v_c text[] := '{}';
BEGIN
  IF p_wallet IS NULL OR p_collection_id IS NULL THEN RAISE EXCEPTION 'wallet and collection required'; END IF;
  IF p_nft_ids IS NULL OR cardinality(p_nft_ids) = 0 THEN
    RETURN jsonb_build_object('a_buys', 0, 'b_unknown_to_buy', 0, 'c_pulls', 0, 'filled_ids', '[]'::jsonb);
  END IF;
  IF cardinality(p_nft_ids) > 500 THEN RAISE EXCEPTION 'at most 500 ids per call (got %)', cardinality(p_nft_ids); END IF;

  -- A. buys with no row
  WITH ids AS (SELECT DISTINCT unnest(p_nft_ids) AS nft_id),
  last AS (
    SELECT i.nft_id, l.buyer, l.seller, l.price, l.sold_at, l.tx, l.is_offer, l.ok_ccy
    FROM ids i
    JOIN LATERAL (
      SELECT s.buyer_address AS buyer, s.seller_address AS seller, s.price_usd AS price, s.sold_at,
             COALESCE(s.transaction_hash, 'own_sale:' || s.id::text) AS tx,
             (s.offer_id IS NOT NULL OR s.source = 'offer_fill') AS is_offer,
             (COALESCE(s.currency, 'USD') IN ('USD', 'DUC', 'USDC')) AS ok_ccy
      FROM sales s
      WHERE p_collection_id <> v_pin AND s.nft_id = i.nft_id AND s.collection_id = p_collection_id
      UNION ALL
      SELECT ps.buyer_address, ps.seller_address, ps.sale_price_usd, ps.sold_at,
             COALESCE(NULLIF(split_part(ps.id::text, '_', 1), ''), 'own_sale:' || ps.id::text), false, true
      FROM pinnacle_sales ps
      WHERE p_collection_id = v_pin AND ps.nft_id = i.nft_id
      ORDER BY 4 DESC
      LIMIT 1
    ) l ON true
  ), ins AS (
    INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, acquired_date, acquired_type, seller_address,
      transaction_hash, source, collection_id, acquisition_method, acquisition_confidence)
    SELECT l.nft_id, p_wallet, l.price, l.sold_at, 1, l.seller, l.tx, 'arrival_fill', p_collection_id,
           CASE WHEN l.is_offer THEN 'offer_accepted' ELSE 'marketplace' END, 'verified'
    FROM last l
    WHERE l.buyer = p_wallet AND l.seller IS DISTINCT FROM p_wallet AND l.price > 0 AND l.ok_ccy
      AND NOT EXISTS (SELECT 1 FROM moment_acquisitions ma WHERE ma.nft_id = l.nft_id AND ma.wallet = p_wallet
                        AND ma.collection_id = p_collection_id)
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING id, nft_id, buy_price
  ), rec AS (
    INSERT INTO flowty_archive.acq_own_history_backfill_20261114 (acq_id, wallet, collection_id, nft_id, arm, price)
    SELECT id, p_wallet, p_collection_id, nft_id, 'A_buy_arrival', buy_price FROM ins RETURNING nft_id
  )
  SELECT COALESCE(array_agg(nft_id), '{}') INTO v_a FROM rec;

  -- B. a lone 'unknown', unpriced row proven by the same sale
  WITH ids AS (SELECT DISTINCT unnest(p_nft_ids) AS nft_id),
  last AS (
    SELECT i.nft_id, l.buyer, l.seller, l.price, l.sold_at, l.is_offer, l.ok_ccy
    FROM ids i
    JOIN LATERAL (
      SELECT s.buyer_address AS buyer, s.seller_address AS seller, s.price_usd AS price, s.sold_at,
             (s.offer_id IS NOT NULL OR s.source = 'offer_fill') AS is_offer,
             (COALESCE(s.currency, 'USD') IN ('USD', 'DUC', 'USDC')) AS ok_ccy
      FROM sales s
      WHERE p_collection_id <> v_pin AND s.nft_id = i.nft_id AND s.collection_id = p_collection_id
      UNION ALL
      SELECT ps.buyer_address, ps.seller_address, ps.sale_price_usd, ps.sold_at, false, true
      FROM pinnacle_sales ps
      WHERE p_collection_id = v_pin AND ps.nft_id = i.nft_id
      ORDER BY 4 DESC
      LIMIT 1
    ) l ON true
  ), tgt AS (
    SELECT ma.id, ma.nft_id, to_jsonb(ma) AS prior, l.price, l.seller, l.sold_at, l.is_offer
    FROM moment_acquisitions ma JOIN last l ON l.nft_id = ma.nft_id
    WHERE ma.wallet = p_wallet AND ma.collection_id = p_collection_id
      AND ma.acquisition_method = 'unknown' AND ma.buy_price IS NULL
      AND l.buyer = p_wallet AND l.seller IS DISTINCT FROM p_wallet AND l.price > 0 AND l.ok_ccy
      AND (SELECT count(*) FROM moment_acquisitions m2 WHERE m2.nft_id = ma.nft_id AND m2.wallet = p_wallet
             AND m2.collection_id = p_collection_id) = 1
  ), upd AS (
    UPDATE moment_acquisitions m
    SET acquisition_method = CASE WHEN t.is_offer THEN 'offer_accepted' ELSE 'marketplace' END,
        buy_price = t.price, seller_address = t.seller, acquired_date = t.sold_at,
        acquisition_confidence = 'verified', source = 'arrival_fill'
    FROM tgt t WHERE m.id = t.id
    RETURNING m.id
  ), rec AS (
    INSERT INTO flowty_archive.acq_own_history_backfill_20261114 (acq_id, wallet, collection_id, nft_id, arm, price, prior)
    SELECT t.id, p_wallet, p_collection_id, t.nft_id, 'B_unknown_arrival', t.price, t.prior FROM tgt t JOIN upd u ON u.id = t.id
    RETURNING nft_id
  )
  SELECT COALESCE(array_agg(nft_id), '{}') INTO v_b FROM rec;

  -- C. pulls this wallet opened, never sold anywhere since
  WITH ids AS (SELECT DISTINCT unnest(p_nft_ids) AS nft_id),
  pulls AS (
    SELECT i.nft_id FROM ids i
    WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE p_collection_id <> v_pin AND s.nft_id = i.nft_id AND s.collection_id = p_collection_id)
      AND NOT EXISTS (SELECT 1 FROM pinnacle_sales ps WHERE p_collection_id = v_pin AND ps.nft_id = i.nft_id)
      AND NOT EXISTS (SELECT 1 FROM moment_acquisitions ma WHERE ma.nft_id = i.nft_id AND ma.wallet = p_wallet
                        AND ma.collection_id = p_collection_id)
      AND (
        (p_collection_id <> v_pin AND EXISTS (SELECT 1 FROM pack_open_pulls o WHERE o.collection_id = p_collection_id
            AND o.nft_id = i.nft_id AND o.opener_address = p_wallet))
        OR (p_collection_id = v_ad AND EXISTS (SELECT 1 FROM allday_pack_pull a WHERE a.moment_nft_id = i.nft_id
            AND a.opener_address = p_wallet))
        OR (p_collection_id = v_pin AND EXISTS (SELECT 1 FROM pinnacle_pack_opens po WHERE po.opener_address = p_wallet
            AND i.nft_id = ANY (po.nft_ids)))
      )
  ), ins AS (
    INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, acquired_type, transaction_hash, source, collection_id,
      acquisition_method, acquisition_confidence)
    SELECT nft_id, p_wallet, 0, 1, 'own_pull:' || nft_id, 'arrival_fill', p_collection_id, 'pack_pull', 'verified'
    FROM pulls
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING id, nft_id
  ), rec AS (
    INSERT INTO flowty_archive.acq_own_history_backfill_20261114 (acq_id, wallet, collection_id, nft_id, arm, price)
    SELECT id, p_wallet, p_collection_id, nft_id, 'C_pull_arrival', 0 FROM ins RETURNING nft_id
  )
  SELECT COALESCE(array_agg(nft_id), '{}') INTO v_c FROM rec;

  RETURN jsonb_build_object('a_buys', cardinality(v_a), 'b_unknown_to_buy', cardinality(v_b), 'c_pulls', cardinality(v_c),
    'filled_ids', to_jsonb(v_a || v_b || v_c));
END
$fn$;

REVOKE ALL ON FUNCTION public.fill_acquisitions_for_moments(text, uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fill_acquisitions_for_moments(text, uuid, text[]) TO service_role;
