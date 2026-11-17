-- 2026-11-14 (~8:40 PM PT, Claude Code cloud). Trevor, 7:19 PM PT: "keep proving and looking for a source for
-- pre-2023 purchases"; 8:15 PM PT: "You get it added yourself. Keep working through these".
--
-- WHY: ~131k Top Shot moments held by saved wallets had no PRICED acquisition row. Our `sales` history has no buyer
-- on any 2020-21 sale, the Flow history access nodes before 2025-10-22 are retired (#181), so the only source that
-- covers 2020 onward is Dune's flow.cadence_events. Dune query 9129294 ("held-moment arrival provenance") finds,
-- per held moment, the LATEST TopShot.Deposit (its arrival in the wallet that holds it now) and the settlement
-- events IN THAT SAME TRANSACTION for THAT nft id:
--   MP = Market / TopShotMarketV3 .MomentPurchased (Top Shot marketplace; price in DUC = USD)
--   LC = NFTStorefront(V2) .ListingCompleted, purchased=true, salePaymentVaultType = DapperUtilityCoin (USD only)
--   OC = OffersV2 / Offers .OfferCompleted, purchased=true, payment vault not FLOW
--   P  = no settlement event, and the TopShot.Withdraw in that tx came FROM a Dapper pack-delivery account
--        (0xe1f2a091f7bb5245 / 0xb6f2481eba4df97b / 0xfa57101aa0d55954) = a pack pull, $0 on the moment side
--   X  = a storefront sale paid in a non-USD vault (not written), S = re-deposit by the same wallet, T = transfer
--        from another address with no settlement event, N = no Withdraw at all (not written: not provable here).
-- Rows land in public.topshot_arrival_provenance (one per wallet, nft, arrival tx); apply_topshot_arrival_provenance()
-- writes ONLY MP/LC/OC/P, ONLY for moments the wallet still holds, ONLY when no priced row exists for
-- (nft, wallet, collection). A lone `unknown` unpriced row is updated in place; otherwise a row is inserted.
-- Every write is recorded in flowty_archive.acq_chain_arrival_20261114.
--
-- REVERT:
--   DELETE FROM moment_acquisitions m USING flowty_archive.acq_chain_arrival_20261114 r
--     WHERE m.id = r.acq_id AND r.arm = 'insert';
--   UPDATE moment_acquisitions m SET acquisition_method = r.prior->>'acquisition_method', buy_price = NULL,
--     seller_address = r.prior->>'seller_address', acquisition_confidence = r.prior->>'acquisition_confidence',
--     source = r.prior->>'source', acquired_date = (r.prior->>'acquired_date')::timestamptz
--     FROM flowty_archive.acq_chain_arrival_20261114 r WHERE m.id = r.acq_id AND r.arm = 'update_unknown';
--   DROP FUNCTION public.apply_topshot_arrival_provenance(); DROP TABLE public.topshot_arrival_provenance;

CREATE TABLE IF NOT EXISTS public.topshot_arrival_provenance (
  wallet text NOT NULL,
  nft_id text NOT NULL,
  arrival_tx text NOT NULL,
  arrival_date date,
  block_height bigint,
  kind text NOT NULL CHECK (kind IN ('MP','LC','OC','P','X','S','T','N')),
  price numeric,
  from_addr text,
  probed_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  applied_result text,
  PRIMARY KEY (wallet, nft_id, arrival_tx)
);
ALTER TABLE public.topshot_arrival_provenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_arrival_provenance FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.topshot_arrival_provenance IS
  'Per held Top Shot moment on a saved wallet: its on-chain arrival tx and what settled in it (Dune query 9129294). '
  'Written by the arrival-provenance lane; applied by apply_topshot_arrival_provenance(). 2026-11-14.';

-- ids already probed (any kind, including "no deposit found"), so the lane never re-buys the same Dune rows
CREATE TABLE IF NOT EXISTS public.topshot_arrival_probed (
  wallet text NOT NULL,
  nft_id text NOT NULL,
  probed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, nft_id)
);
ALTER TABLE public.topshot_arrival_probed ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_arrival_probed FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS flowty_archive.acq_chain_arrival_20261114 (
  acq_id uuid NOT NULL,
  wallet text NOT NULL,
  nft_id text NOT NULL,
  arm text NOT NULL,
  kind text NOT NULL,
  price numeric,
  prior jsonb,
  written_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON flowty_archive.acq_chain_arrival_20261114 FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.apply_topshot_arrival_provenance()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  n_ins int := 0; n_upd int := 0; usd numeric := 0; n_skip int := 0;
BEGIN
  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  SELECT p.wallet, p.nft_id, p.arrival_tx, p.arrival_date, p.kind,
         CASE WHEN p.kind = 'P' THEN 0 ELSE p.price END AS price, p.from_addr
  FROM topshot_arrival_provenance p
  WHERE p.applied_at IS NULL
    AND (p.kind = 'P' OR (p.kind IN ('MP','LC','OC') AND p.price > 0))
    AND EXISTS (SELECT 1 FROM wallet_moments_cache w WHERE w.wallet_address = p.wallet AND w.moment_id = p.nft_id
                  AND w.collection_id = v_ts)
    AND NOT EXISTS (SELECT 1 FROM moment_acquisitions ma WHERE ma.nft_id = p.nft_id AND ma.wallet = p.wallet
                      AND ma.collection_id = v_ts AND ma.buy_price IS NOT NULL);

  -- a lone `unknown` unpriced row: update it in place
  WITH tgt AS (
    SELECT ma.id, c.wallet, c.nft_id, c.kind, c.price, c.arrival_date, c.from_addr, to_jsonb(ma) AS prior
    FROM _cand c JOIN moment_acquisitions ma ON ma.nft_id = c.nft_id AND ma.wallet = c.wallet AND ma.collection_id = v_ts
    WHERE ma.acquisition_method = 'unknown' AND ma.buy_price IS NULL
      AND (SELECT count(*) FROM moment_acquisitions m2 WHERE m2.nft_id = c.nft_id AND m2.wallet = c.wallet
             AND m2.collection_id = v_ts) = 1
  ), upd AS (
    UPDATE moment_acquisitions m
    SET acquisition_method = CASE t.kind WHEN 'P' THEN 'pack_pull' WHEN 'OC' THEN 'offer_accepted' ELSE 'marketplace' END,
        buy_price = t.price,
        seller_address = CASE WHEN t.kind = 'P' THEN NULL ELSE t.from_addr END,
        acquired_date = t.arrival_date::timestamptz,
        acquisition_confidence = 'verified', source = 'chain_arrival_dune_20261114'
    FROM tgt t WHERE m.id = t.id
    RETURNING m.id
  ), rec AS (
    INSERT INTO flowty_archive.acq_chain_arrival_20261114 (acq_id, wallet, nft_id, arm, kind, price, prior)
    SELECT t.id, t.wallet, t.nft_id, 'update_unknown', t.kind, t.price, t.prior FROM tgt t JOIN upd u ON u.id = t.id
    RETURNING wallet, nft_id, price
  ), mark AS (
    UPDATE topshot_arrival_provenance p SET applied_at = now(), applied_result = 'update_unknown'
    FROM rec r WHERE p.wallet = r.wallet AND p.nft_id = r.nft_id AND p.applied_at IS NULL
    RETURNING 1
  )
  SELECT count(*), COALESCE(sum(price), 0) INTO n_upd, usd FROM rec;

  DELETE FROM _cand c USING topshot_arrival_provenance p
  WHERE p.wallet = c.wallet AND p.nft_id = c.nft_id AND p.arrival_tx = c.arrival_tx AND p.applied_at IS NOT NULL;

  WITH ins AS (
    INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, acquired_date, acquired_type, seller_address,
      transaction_hash, source, collection_id, acquisition_method, acquisition_confidence)
    SELECT c.nft_id, c.wallet, c.price, c.arrival_date::timestamptz, 1,
           CASE WHEN c.kind = 'P' THEN NULL ELSE c.from_addr END,
           c.arrival_tx, 'chain_arrival_dune_20261114', v_ts,
           CASE c.kind WHEN 'P' THEN 'pack_pull' WHEN 'OC' THEN 'offer_accepted' ELSE 'marketplace' END, 'verified'
    FROM _cand c
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING id, nft_id, wallet, buy_price, acquisition_method
  ), rec AS (
    INSERT INTO flowty_archive.acq_chain_arrival_20261114 (acq_id, wallet, nft_id, arm, kind, price)
    SELECT id, wallet, nft_id, 'insert', acquisition_method, buy_price FROM ins
    RETURNING wallet, nft_id, price
  ), mark AS (
    UPDATE topshot_arrival_provenance p SET applied_at = now(), applied_result = 'insert'
    FROM rec r WHERE p.wallet = r.wallet AND p.nft_id = r.nft_id AND p.applied_at IS NULL
    RETURNING 1
  )
  SELECT count(*), usd + COALESCE(sum(price), 0) INTO n_ins, usd FROM rec;

  SELECT count(*) INTO n_skip FROM topshot_arrival_provenance WHERE applied_at IS NULL;
  DROP TABLE IF EXISTS _cand;
  RETURN jsonb_build_object('inserted', n_ins, 'updated_unknown', n_upd, 'usd', usd, 'not_applied_total', n_skip);
END;
$fn$;
REVOKE ALL ON FUNCTION public.apply_topshot_arrival_provenance() FROM PUBLIC, anon, authenticated;

-- next held, unpriced Top Shot moments on saved wallets not yet probed, highest FMV first
CREATE OR REPLACE FUNCTION public.topshot_arrival_probe_targets(p_limit int DEFAULT 2000)
RETURNS TABLE (wallet text, nft_id text, fmv_usd numeric)
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $fn$
  SELECT w.wallet_address, w.moment_id, w.fmv_usd
  FROM wallet_moments_cache w
  WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND w.wallet_address IN (SELECT DISTINCT lower(sw.wallet_addr) FROM saved_wallets sw
                              WHERE sw.wallet_addr ~* '^0x[0-9a-f]{16}$')
    AND NOT EXISTS (SELECT 1 FROM moment_acquisitions a WHERE a.nft_id = w.moment_id AND a.wallet = w.wallet_address
                      AND a.collection_id = w.collection_id AND a.buy_price IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM topshot_arrival_probed pr WHERE pr.wallet = w.wallet_address AND pr.nft_id = w.moment_id)
  ORDER BY w.fmv_usd DESC NULLS LAST, w.moment_id
  LIMIT p_limit
$fn$;
REVOKE ALL ON FUNCTION public.topshot_arrival_probe_targets(int) FROM PUBLIC, anon, authenticated;
