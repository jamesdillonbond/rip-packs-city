-- audit_20260930_allday_multi_claim_takes_unsplittable_buyback_carts
-- anon-exec: unchanged (claim_allday_v1_multi_price_recovery_candidates) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false / service_role=true before applying.
--
-- WHAT THIS UNBLOCKS — 14,694 open All Day unmapped_sales rows parked at $0 with
-- resolution_hint->>'price_extraction' = 'v1_tx_decode_multi_nft_unsplittable'
-- (4,852 three-NFT carts + 41 two-NFT + 13 four-NFT, Feb–Jul 2026). The 09-29 multi-NFT
-- pass (20260929130635) only ever selected the OTHER marker, 'v1_tx_decode_budget_exhausted',
-- so these were never re-tried, and the lane has claimed 0 rows on every tick since that
-- backlog drained (09-30).
--
-- ⭐ They are PACK BUYBACKS (register #161): a chain sample of 14 carts ran Dapper's "Fulfills a
-- pack buyback offer" script 14/14, and decodeV1MultiSaleTx priced all 42 NFTs with certainty
-- ($0.50 / $1.50 / $2). Trevor, 2026-09-30: "Buybacks should still count as market sales on both,
-- but should be tracked additionally" — so they are priced and promoted like any other sale.
--
-- ⛔ MULTI PATH ONLY, including the 4 rows whose cart has a single OPEN row left: the marker says
-- the tx moved several NFTs, and the singleton claim's decodeV1SaleTx returns the tx's GROSS DUC,
-- which would price one NFT at the whole cart. The singleton claim is deliberately untouched.
-- Measured before applying: 0 transactions carry both markers.
--
-- INDEX: the existing partial index covers only the budget-exhausted marker; this adds one over
-- both markers so the claim keeps its ordered, early-stopping scan. unmapped_sales is 77k rows /
-- 73 MB heap, so a plain (non-CONCURRENT) build is sub-second.
--
-- REVERT: re-apply the function body from 20260929130635 and
--   DROP INDEX IF EXISTS public.idx_unmapped_allday_price_recover_targets_v2;
-- Rows already priced keep their price (hint price_source = 'v1_multi_nft_segment').

CREATE INDEX IF NOT EXISTS idx_unmapped_allday_price_recover_targets_v2
  ON public.unmapped_sales USING btree (collection_id, transaction_hash)
  WHERE resolved_at IS NULL
    AND (resolution_hint->>'price_extraction') IN ('v1_tx_decode_budget_exhausted', 'v1_tx_decode_multi_nft_unsplittable');

CREATE OR REPLACE FUNCTION public.claim_allday_v1_multi_price_recovery_candidates(p_tx_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, nft_id text, transaction_hash text, resolved_at timestamptz, resolution_hint jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
  WITH cand AS (
    SELECT u.id, u.nft_id, u.transaction_hash::text AS transaction_hash, u.resolved_at, u.resolution_hint,
           count(*) OVER (PARTITION BY u.transaction_hash) AS tx_rows,
           bool_or(COALESCE((u.resolution_hint->>'multi_price_attempted_at')::timestamptz
                              > now() - interval '30 days', false))
             OVER (PARTITION BY u.transaction_hash) AS recently_tried
    FROM public.unmapped_sales u
    WHERE u.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND u.resolved_at IS NULL
      AND u.resolution_hint->>'price_extraction' IN ('v1_tx_decode_budget_exhausted', 'v1_tx_decode_multi_nft_unsplittable')
  ),
  txs AS (
    SELECT DISTINCT cand.transaction_hash
    FROM cand
    -- A budget-exhausted tx is multi-NFT only when it has >1 open row. An 'unsplittable' row is
    -- multi-NFT by its marker even when its siblings already resolved (see header).
    WHERE (cand.tx_rows > 1 OR cand.resolution_hint->>'price_extraction' = 'v1_tx_decode_multi_nft_unsplittable')
      AND NOT cand.recently_tried
    ORDER BY cand.transaction_hash
    LIMIT LEAST(GREATEST(COALESCE(p_tx_limit, 100), 1), 500)
  )
  SELECT c.id, c.nft_id, c.transaction_hash, c.resolved_at, c.resolution_hint
  FROM cand c
  JOIN txs t ON t.transaction_hash = c.transaction_hash
  -- Deterministic on a UNIQUE key within a tx.
  ORDER BY c.transaction_hash, c.id;
$function$;

COMMENT ON FUNCTION public.claim_allday_v1_multi_price_recovery_candidates(integer) IS
  'Candidate picker for the MULTI-NFT pass of allday-price-recover: whole transactions that are '
  'multi-NFT (more than one open budget-exhausted row, or any open row marked '
  'v1_tx_decode_multi_nft_unsplittable), ordered by transaction_hash, skipping any tx stamped '
  'multi_price_attempted_at within 30 days. The unsplittable population is All Day pack buybacks, '
  'which count as market sales (register #161). See migrations 20260929130635 and this one.';

DO $mig$
DECLARE
  v_anon boolean;
  v_svc boolean;
  v_n int;
BEGIN
  SELECT has_function_privilege('anon', 'public.claim_allday_v1_multi_price_recovery_candidates(integer)', 'EXECUTE'),
         has_function_privilege('service_role', 'public.claim_allday_v1_multi_price_recovery_candidates(integer)', 'EXECUTE')
    INTO v_anon, v_svc;
  IF v_anon OR NOT v_svc THEN
    RAISE EXCEPTION 'ACL drifted: anon=% service_role=%', v_anon, v_svc;
  END IF;
  SELECT count(*) INTO v_n FROM public.claim_allday_v1_multi_price_recovery_candidates(100);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'claim returned 0 rows; expected the unsplittable carts to be claimable';
  END IF;
  RAISE NOTICE 'multi claim now returns % rows for 100 txs', v_n;
END
$mig$;
