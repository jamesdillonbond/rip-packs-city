-- audit_20261117_topshot_arrival_dates_unsettled_kinds
--
-- 2026-11-17 (Claude Code cloud; Trevor: "Keep going and working through those still open").
--
-- WHY. apply_topshot_arrival_transfers() (20261117044500) wrote the on-chain arrival DATE for kind T. Two more
-- stored-but-never-written kinds in topshot_arrival_provenance have the same property — the row is the moment's
-- LATEST TopShot.Deposit into the wallet that holds it now, so its arrival_date is a fact whatever moved it:
--   · N — a Deposit whose transaction has no TopShot.Withdraw (the mechanism is unverified: Dune credits were
--         exhausted 11-17, so the sending side could not be read). 1,298 held moments writable (dry run below).
--   · X — a storefront purchase paid in a NON-USD vault (a real purchase; no dollar price). 108 writable.
-- Dry run 2026-11-17: N 955 insert + 343 re-date, X 85 + 23 (same exclusions as the T function).
-- Kind S (re-deposit by the SAME wallet) is NOT an acquisition and stays unwritten.
--
-- WHAT. apply_topshot_arrival_dates(p_kinds, p_limit) is the T function's logic for any of N / X / T, written as
-- ONE statement (no temp table): method stays 'unknown', buy_price NULL (no P&L; X's non-USD price is not
-- converted), seller_address = from_addr (NULL for N), source 'chain_arrival_' || lower(kind)-name. Guards, all
-- unchanged from the T function: latest probed arrival only; wallet still holds it and its wmc row predates the
-- probe; no sale on/after the arrival day; (nft, wallet, Top Shot) has no row or exactly one unknown unpriced row.
-- Archived in flowty_archive.acq_chain_arrival_20261114 (arms arrival_insert / arrival_update_unknown, kind = N|X|T).
--
-- anon-exec: revoked (apply_topshot_arrival_dates) — writes moment_acquisitions; service_role only.
--
-- REVERT:
--   DELETE FROM moment_acquisitions m USING flowty_archive.acq_chain_arrival_20261114 r
--     WHERE m.id = r.acq_id AND r.arm = 'arrival_insert';
--   UPDATE moment_acquisitions m SET acquired_date = (r.prior->>'acquired_date')::timestamptz,
--     seller_address = r.prior->>'seller_address', acquisition_confidence = r.prior->>'acquisition_confidence',
--     source = r.prior->>'source'
--     FROM flowty_archive.acq_chain_arrival_20261114 r WHERE m.id = r.acq_id AND r.arm = 'arrival_update_unknown';
--   UPDATE topshot_arrival_provenance SET applied_at = NULL, applied_result = NULL
--     WHERE applied_result IN ('arrival_update_unknown', 'arrival_insert');
--   DROP FUNCTION public.apply_topshot_arrival_dates(text[], integer);

CREATE OR REPLACE FUNCTION public.apply_topshot_arrival_dates(p_kinds text[], p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_out jsonb;
BEGIN
  IF p_kinds IS NULL OR cardinality(p_kinds) = 0 OR NOT (p_kinds <@ ARRAY['N','X','T']) THEN
    RAISE EXCEPTION 'p_kinds must be a non-empty subset of {N,X,T} (got %)', p_kinds;
  END IF;

  WITH latest AS (
    SELECT DISTINCT ON (p.wallet, p.nft_id) p.wallet, p.nft_id, p.arrival_tx, p.arrival_date, p.kind,
           p.from_addr, p.probed_at, p.applied_at
    FROM topshot_arrival_provenance p
    ORDER BY p.wallet, p.nft_id, p.block_height DESC NULLS LAST, p.arrival_date DESC NULLS LAST
  ), cand AS (
    SELECT l.wallet, l.nft_id, l.arrival_tx, l.arrival_date, l.from_addr, l.kind,
           (SELECT count(*) FROM moment_acquisitions ma WHERE ma.nft_id = l.nft_id AND ma.wallet = l.wallet
              AND ma.collection_id = v_ts) AS nrows
    FROM latest l
    JOIN wallet_moments_cache w ON w.wallet_address = l.wallet AND w.moment_id = l.nft_id AND w.collection_id = v_ts
    WHERE l.kind = ANY (p_kinds) AND l.applied_at IS NULL AND l.arrival_date IS NOT NULL
      AND w.created_at <= l.probed_at
      AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.nft_id = l.nft_id AND s.collection_id = v_ts
                        AND s.sold_at >= l.arrival_date::timestamptz)
      -- writable by exactly one arm: no row, or ONE row that is 'unknown' and unpriced (so a batch never stalls)
      AND (SELECT count(*) FROM moment_acquisitions ma WHERE ma.nft_id = l.nft_id AND ma.wallet = l.wallet
             AND ma.collection_id = v_ts)
          = (SELECT count(*) FROM moment_acquisitions ma WHERE ma.nft_id = l.nft_id AND ma.wallet = l.wallet
             AND ma.collection_id = v_ts AND ma.acquisition_method = 'unknown' AND ma.buy_price IS NULL)
      AND (SELECT count(*) FROM moment_acquisitions ma WHERE ma.nft_id = l.nft_id AND ma.wallet = l.wallet
             AND ma.collection_id = v_ts) <= 1
    LIMIT p_limit
  ), tgt AS (
    SELECT ma.id, c.wallet, c.nft_id, c.kind, c.arrival_tx, c.arrival_date, c.from_addr, to_jsonb(ma) AS prior
    FROM cand c JOIN moment_acquisitions ma ON ma.nft_id = c.nft_id AND ma.wallet = c.wallet AND ma.collection_id = v_ts
    WHERE c.nrows = 1
  ), upd AS (
    UPDATE moment_acquisitions m
    SET acquired_date = t.arrival_date::timestamptz, seller_address = t.from_addr,
        acquisition_confidence = 'verified',
        source = CASE t.kind WHEN 'T' THEN 'chain_arrival_transfer' WHEN 'N' THEN 'chain_arrival_no_withdraw'
                             ELSE 'chain_arrival_non_usd_sale' END
    FROM tgt t WHERE m.id = t.id
    RETURNING m.id
  ), rec_u AS (
    INSERT INTO flowty_archive.acq_chain_arrival_20261114 (acq_id, wallet, nft_id, arm, kind, price, prior)
    SELECT t.id, t.wallet, t.nft_id, 'arrival_update_unknown', t.kind, NULL, t.prior FROM tgt t JOIN upd u ON u.id = t.id
    RETURNING wallet, nft_id
  ), mark_u AS (
    UPDATE topshot_arrival_provenance p SET applied_at = now(), applied_result = 'arrival_update_unknown'
    FROM tgt t JOIN upd u ON u.id = t.id
    WHERE p.wallet = t.wallet AND p.nft_id = t.nft_id AND p.arrival_tx = t.arrival_tx
    RETURNING 1
  ), ins AS (
    INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, acquired_date, acquired_type, seller_address,
      transaction_hash, source, collection_id, acquisition_method, acquisition_confidence)
    SELECT c.nft_id, c.wallet, NULL, c.arrival_date::timestamptz, 1, c.from_addr, c.arrival_tx,
           CASE c.kind WHEN 'T' THEN 'chain_arrival_transfer' WHEN 'N' THEN 'chain_arrival_no_withdraw'
                       ELSE 'chain_arrival_non_usd_sale' END,
           v_ts, 'unknown', 'verified'
    FROM cand c
    WHERE c.nrows = 0
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING id, nft_id, wallet, transaction_hash
  ), rec_i AS (
    INSERT INTO flowty_archive.acq_chain_arrival_20261114 (acq_id, wallet, nft_id, arm, kind, price)
    SELECT i.id, i.wallet, i.nft_id, 'arrival_insert', c.kind, NULL
    FROM ins i JOIN cand c ON c.wallet = i.wallet AND c.nft_id = i.nft_id AND c.arrival_tx = i.transaction_hash
    RETURNING wallet, nft_id
  ), mark_i AS (
    UPDATE topshot_arrival_provenance p SET applied_at = now(), applied_result = 'arrival_insert'
    FROM ins i WHERE p.wallet = i.wallet AND p.nft_id = i.nft_id AND p.arrival_tx = i.transaction_hash
    RETURNING 1
  )
  SELECT jsonb_build_object(
           'candidates', (SELECT count(*) FROM cand),
           'updated_unknown', (SELECT count(*) FROM rec_u),
           'inserted', (SELECT count(*) FROM rec_i),
           'provenance_marked', (SELECT count(*) FROM mark_u) + (SELECT count(*) FROM mark_i))
    INTO v_out;
  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION public.apply_topshot_arrival_dates(text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_topshot_arrival_dates(text[], integer) TO service_role;
