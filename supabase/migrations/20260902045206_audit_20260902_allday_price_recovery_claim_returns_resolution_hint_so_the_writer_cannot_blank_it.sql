-- audit_20260902_allday_price_recovery_claim_returns_resolution_hint_so_the_writer_cannot_blank_it
-- anon-exec: claim_allday_v1_price_recovery_candidates — SECURITY DEFINER; EXECUTE REVOKEd from
-- PUBLIC, anon and authenticated in ONE statement and granted to service_role only, re-asserted
-- below with has_function_privilege (never the acl text) because DROP + CREATE resets the ACL.
--
-- Caught before the route shipped, not after: the claim added minutes earlier (20260902045049)
-- returned no `resolution_hint`, and the route's write path does
--   const cleaned = { ...(row.resolution_hint ?? {}) }; delete cleaned.price_extraction; …
-- then writes `cleaned` back. With the field undefined that spreads to `{}` and the UPDATE would
-- have REPLACED the whole hint object with an empty one — silently discarding every other key it
-- held, on each of the 9,859 rows as they were recovered.
--
-- ⭐ The shape is worth naming: **a claim that returns FEWER columns is not free when the writer
-- round-trips one of them.** `?? {}` turned a missing column into a positive claim that the object
-- was empty — the fabricated-value shape, in jsonb rather than in a number. The route's existing
-- test caught it (`resolution_hint` is asserted `toEqual({ backfill: "allday_v1_history" })`), which
-- is what an assertion on the SURVIVING content buys over one on the field's presence.
--
-- RETURNS TABLE changes, so this is DROP + CREATE, not CREATE OR REPLACE (42P13 otherwise).
-- Safe: the only caller is a route that had not deployed yet.
--
-- REVERT: DROP FUNCTION public.claim_allday_v1_price_recovery_candidates(integer); and revert the
-- route commit. This function only READS.

DROP FUNCTION IF EXISTS public.claim_allday_v1_price_recovery_candidates(integer);

CREATE FUNCTION public.claim_allday_v1_price_recovery_candidates(p_limit integer DEFAULT 500)
 RETURNS TABLE(id uuid, nft_id text, transaction_hash text, resolved_at timestamptz, resolution_hint jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
  WITH cand AS (
    SELECT u.id, u.nft_id, u.transaction_hash::text AS transaction_hash, u.resolved_at,
           u.resolution_hint,
           count(*) OVER (PARTITION BY u.transaction_hash) AS tx_rows
    FROM public.unmapped_sales u
    WHERE u.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND u.resolved_at IS NULL
      AND u.resolution_hint->>'price_extraction' = 'v1_tx_decode_budget_exhausted'
  )
  SELECT cand.id, cand.nft_id, cand.transaction_hash, cand.resolved_at, cand.resolution_hint
  FROM cand
  -- EXACTLY ONE row for the tx: decodeV1SaleTx returns the tx's GROSS DUC total, which is only
  -- attributable to an NFT when the tx moved exactly one.
  WHERE cand.tx_rows = 1
  -- Deterministic, on a UNIQUE key. Without it this is physical order and the walk re-reads the same
  -- page forever, which is the defect this function exists to fix.
  ORDER BY cand.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000);
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_allday_v1_price_recovery_candidates(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_allday_v1_price_recovery_candidates(integer) TO service_role;

COMMENT ON FUNCTION public.claim_allday_v1_price_recovery_candidates(integer) IS
  'Candidate picker for allday-price-recover. Returns only rows whose transaction has EXACTLY ONE '
  'unresolved budget-exhausted candidate, because decodeV1SaleTx returns the transaction''s gross DUC '
  'total and that is attributable to an NFT only when the transaction moved one. '
  '⚠ WHY IT EXISTS (2026-09-02): the route read `unmapped_sales` directly with NO ORDER BY, so it got '
  'physical order — the same page every tick — and threw away 999 of every 1,000 rows as multi-NFT, '
  'decoding ONE. Measured population: 47,691 candidates over 21,409 txs, of which 9,859 are singleton '
  'txs and recoverable; at one per tick that is ~137 days. '
  '⚠ The route asked for 2,000 and PostgREST CLAMPED it to 1,000 — `extra.candidates` read exactly '
  '1000 forever, which is what the cap looks like from the outside. '
  '⛔ The ORDER BY on the UNIQUE id is load-bearing: without it this is physical order again. '
  '⛔ resolution_hint IS RETURNED ON PURPOSE. The route rebuilds the hint object from this value and '
  'writes it back, so dropping the column would spread `?? {}` into an UPDATE that REPLACES the hint '
  'with an empty object — a missing column turned into a positive claim that it was empty. '
  'COST: the partial index idx_unmapped_allday_price_recover_targets is ordered by transaction_hash, '
  'so the window needs no sort — ~95 ms, ~27,194 buffers, ALL shared HIT and zero disk reads. '
  '👉 The 37,832 rows in multi-NFT txs are still inside the predicate, so this scans 47,691 to return '
  '9,859 and will scan 47,691 to return none once drained. Re-classifying them (that is what the EMPTY '
  'unmapped_sales_resolution_failures table is for) is the follow-up.';

DO $mig$
DECLARE
  v_rows int;
  v_multi int;
  v_no_hint int;
BEGIN
  IF has_function_privilege('anon', 'public.claim_allday_v1_price_recovery_candidates(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon has EXECUTE';
  END IF;
  IF has_function_privilege('authenticated', 'public.claim_allday_v1_price_recovery_candidates(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: authenticated has EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.claim_allday_v1_price_recovery_candidates(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: service_role has no EXECUTE — the route would 403';
  END IF;

  SELECT count(*) INTO v_rows FROM public.claim_allday_v1_price_recovery_candidates(200);
  IF v_rows <> 200 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 200 candidates, got %', v_rows;
  END IF;

  -- THE REASON THIS MIGRATION EXISTS: every claimed row must carry its hint, and the hint must carry
  -- the marker the writer strips. A NULL or empty hint here is what would have blanked the column.
  SELECT count(*) INTO v_no_hint
  FROM public.claim_allday_v1_price_recovery_candidates(200) c
  WHERE c.resolution_hint IS NULL
     OR c.resolution_hint = '{}'::jsonb
     OR c.resolution_hint->>'price_extraction' IS DISTINCT FROM 'v1_tx_decode_budget_exhausted';
  IF v_no_hint <> 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: % of 200 claimed rows came back without a usable resolution_hint', v_no_hint;
  END IF;

  SELECT count(*) INTO v_multi
  FROM public.claim_allday_v1_price_recovery_candidates(200) c
  WHERE (
    SELECT count(*) FROM public.unmapped_sales u
    WHERE u.transaction_hash = c.transaction_hash
      AND u.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND u.resolved_at IS NULL
      AND u.resolution_hint->>'price_extraction' = 'v1_tx_decode_budget_exhausted'
  ) <> 1;
  IF v_multi <> 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: % of 200 claimed rows belong to a multi-NFT tx', v_multi;
  END IF;

  RAISE NOTICE 'post-state ok: 200/200 claimed, 0 multi-NFT, 0 missing a usable resolution_hint';
END
$mig$;
