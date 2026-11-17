-- audit_20260929_allday_price_recovery_claims_multi_nft_txs
-- anon-exec: NEW function claim_allday_v1_multi_price_recovery_candidates — SECURITY DEFINER,
-- EXECUTE REVOKEd from PUBLIC, anon and authenticated in ONE statement and granted to service_role
-- only (asserted below with has_function_privilege, never the acl text).
--
-- WHAT THIS UNBLOCKS — ~23.4k All Day sales parked with price 0 as "unsplittable".
--
-- `claim_allday_v1_price_recovery_candidates` (20260902) deliberately returns only transactions
-- with ONE open row, because `decodeV1SaleTx` returns a tx's GROSS DUC and that is one NFT's price
-- only when the tx moved one. Measured 2026-09-29, the rest of the budget-exhausted backlog:
--     2-NFT txs 6,292 · 3-NFT txs 3,585 · 4-NFT txs 31   (~23.4k rows)
-- ⭐ They ARE splittable: each listing is purchased in its own event block (ListingAvailable →
-- contract-sourced DUC TokensWithdrawn → … → ListingCompleted), so walking events by index and
-- cutting at every ListingCompleted attributes each payment to its NFT —
-- `attributeV1MultiSalePrices` in lib/chains/flow/dapper-v1-tx-decode.ts, proven on real txs
-- ($0.67 / $0.67 / $0.66 in one cart). This function hands the route WHOLE transactions.
--
-- ⛔ HEAD-OF-LINE: ordered by transaction_hash, a tx that fails to decode would be re-claimed first
-- forever and the walk would stall at zero progress with nothing reporting it (CLAUDE.md, "a leg's
-- ORDER BY decides whether it progresses"). The route stamps `multi_price_attempted_at` on every row
-- of a tx it could not price, and this function skips any tx carrying a stamp younger than 30 days.
--
-- COST (measured, this predicate + LIMIT 100): 2.7 ms, 147 buffers, all shared hit — the partial
-- index idx_unmapped_allday_price_recover_targets is ordered by transaction_hash, so the window and
-- the DISTINCT stream without a sort and stop early.
--
-- REVERT: DROP FUNCTION public.claim_allday_v1_multi_price_recovery_candidates(integer); and revert
-- the route commit. This function only READS.

CREATE FUNCTION public.claim_allday_v1_multi_price_recovery_candidates(p_tx_limit integer DEFAULT 100)
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
      AND u.resolution_hint->>'price_extraction' = 'v1_tx_decode_budget_exhausted'
  ),
  txs AS (
    SELECT DISTINCT cand.transaction_hash
    FROM cand
    WHERE cand.tx_rows > 1
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

REVOKE EXECUTE ON FUNCTION public.claim_allday_v1_multi_price_recovery_candidates(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_allday_v1_multi_price_recovery_candidates(integer) TO service_role;

COMMENT ON FUNCTION public.claim_allday_v1_multi_price_recovery_candidates(integer) IS
  'Candidate picker for the MULTI-NFT pass of allday-price-recover: whole transactions with more '
  'than one open budget-exhausted row, ordered by transaction_hash, skipping any tx stamped '
  'multi_price_attempted_at within 30 days (so a tx that cannot be priced does not block the head '
  'of the walk forever). The route prices each NFT with attributeV1MultiSalePrices '
  '(lib/chains/flow/dapper-v1-tx-decode.ts). resolution_hint is returned because the writer '
  'round-trips it. See migration 20260929131000.';

DO $mig$
DECLARE
  v_rows int;
  v_txs int;
  v_single int;
BEGIN
  IF has_function_privilege('anon', 'public.claim_allday_v1_multi_price_recovery_candidates(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon has EXECUTE';
  END IF;
  IF has_function_privilege('authenticated', 'public.claim_allday_v1_multi_price_recovery_candidates(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: authenticated has EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.claim_allday_v1_multi_price_recovery_candidates(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: service_role has no EXECUTE — the route would 403';
  END IF;

  SELECT count(*), count(DISTINCT transaction_hash) INTO v_rows, v_txs
  FROM public.claim_allday_v1_multi_price_recovery_candidates(50);
  IF v_txs <> 50 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 50 transactions, got %', v_txs;
  END IF;

  -- Every claimed tx must be multi-row — a singleton here would be decoded twice, once per pass.
  SELECT count(*) INTO v_single
  FROM (SELECT transaction_hash, count(*) n
          FROM public.claim_allday_v1_multi_price_recovery_candidates(50) GROUP BY 1) g
  WHERE g.n < 2;
  IF v_single <> 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: % claimed transactions have a single row', v_single;
  END IF;

  RAISE NOTICE 'post-state ok: 50 txs / % rows claimed, all multi-row, service_role only', v_rows;
END
$mig$;
