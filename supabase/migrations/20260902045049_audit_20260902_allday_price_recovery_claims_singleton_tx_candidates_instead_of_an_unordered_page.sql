-- audit_20260902_allday_price_recovery_claims_singleton_tx_candidates_instead_of_an_unordered_page
-- anon-exec: NEW function claim_allday_v1_price_recovery_candidates — SECURITY DEFINER, EXECUTE
-- REVOKEd from PUBLIC, anon and authenticated in ONE statement and granted to service_role only
-- (asserted below with has_function_privilege, never the acl text).
--
-- WHAT THIS UNBLOCKS — a 9,859-row recovery that was moving at ONE row per run.
--
-- `allday-price-recover` re-decodes AllDay V1-Dapper sales that the history backfill parked with
-- price 0. Every single run reports the same thing:
--
--     candidates 1000 · distinct_txs 304 · skipped_multi_nft_rows 999
--     fail_reasons {multi_nft_tx_total_unsplittable: 999} · tx_decode_ok 1
--
-- ⭐ **It is not failing. It is reading the wrong 1,000 rows, over and over.** The route selects
-- candidates from `unmapped_sales` with **no ORDER BY**, so it gets physical order — the same page
-- every time — and then discards 999 of them because a multi-NFT V1 tx yields one gross DUC total
-- that cannot be split per-NFT. One row per tick, 72 ticks a day.
--
-- ⚠ AND THE LIMIT IT ASKS FOR IS NOT THE LIMIT IT GETS: the route sets `CANDIDATE_LIMIT = 2000`,
-- and PostgREST CLAMPS that to **1,000** — visible in `extra.candidates`, which reads exactly 1000
-- forever. A live instance of the documented cap, hiding in a constant that looks deliberate.
--
-- THE REAL POPULATION, measured (unresolved · AllDay · `price_extraction =
-- 'v1_tx_decode_budget_exhausted'`):
--
--     candidate rows ........................ 47,691
--     distinct transactions ................. 21,409
--     SINGLETON txs — recoverable, 1 decode ..  9,859   ← starved
--     rows inside multi-NFT txs ............. 37,832   ← permanently unsplittable here
--
-- At one row per tick the 9,859 need **~137 days**. The route's own elapsed budget (200 s at ~80 ms
-- per decode plus the Flow round-trip) can do hundreds per tick, so with the right candidates the
-- backlog is a day's work, and those sales get a real price instead of the parked 0 —
-- `promote_unmapped_sales` then moves them into `public.sales`, which is FMV input.
--
-- ⛔ THIS IS NOT A NEW SCAN. The partial index `idx_unmapped_allday_price_recover_targets`
-- `(collection_id, transaction_hash) WHERE resolved_at IS NULL AND price_extraction = '…'` already
-- exists for exactly this predicate, and because it is ordered by `transaction_hash` the
-- `PARTITION BY transaction_hash` window needs **no sort**. Measured: **95 ms, 27,194 buffers, ALL
-- shared HIT and ZERO disk reads** — this instance's constraint is `shared_blks_read`, and this adds
-- none of it.
--
-- ⚠ THE MULTI-NFT SKIP STAYS IN THE ROUTE. It is not redundant: this function's answer is a snapshot,
-- and a second row for the same tx can arrive between the claim and the decode. Belt and braces, and
-- the route now reports `skipped_multi_nft_rows` as a number that should be ~0 rather than 999 —
-- which is what makes a regression here visible instead of normal.
--
-- 👉 FOLLOW-UP, deliberately NOT done here: the 37,832 permanently-unsplittable rows still sit inside
-- the candidate predicate, so this function scans 47,691 rows to return 9,859 and, once drained, will
-- scan 47,691 to return none. Re-classifying them (`unmapped_sales_resolution_failures` exists for
-- this and is EMPTY, so the classification is computed and thrown away every tick) would shrink the
-- scan to the live set. That is a 37,832-row data mutation and belongs in its own change with its own
-- revert path, not bundled into a fix that needs none.
--
-- REVERT: `DROP FUNCTION public.claim_allday_v1_price_recovery_candidates(integer);` and revert the
-- route commit. Nothing else changes; this function only READS.

CREATE OR REPLACE FUNCTION public.claim_allday_v1_price_recovery_candidates(p_limit integer DEFAULT 500)
 RETURNS TABLE(id uuid, nft_id text, transaction_hash text, resolved_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
  WITH cand AS (
    SELECT u.id, u.nft_id, u.transaction_hash::text AS transaction_hash, u.resolved_at,
           count(*) OVER (PARTITION BY u.transaction_hash) AS tx_rows
    FROM public.unmapped_sales u
    WHERE u.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND u.resolved_at IS NULL
      AND u.resolution_hint->>'price_extraction' = 'v1_tx_decode_budget_exhausted'
  )
  SELECT cand.id, cand.nft_id, cand.transaction_hash, cand.resolved_at
  FROM cand
  -- EXACTLY ONE row for the tx: decodeV1SaleTx returns the tx's GROSS DUC total, which is only
  -- attributable to an NFT when the tx moved exactly one.
  WHERE cand.tx_rows = 1
  -- Deterministic, on a UNIQUE key. Without it this is physical order and the walk re-reads the same
  -- page forever, which is the defect this function exists to fix — reintroducing it here would be
  -- the same bug one layer down.
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
  '⛔ The ORDER BY on the UNIQUE id is load-bearing: without it this is physical order again and the '
  'walk re-reads one page, which is the bug this function exists to remove. '
  'COST: the partial index idx_unmapped_allday_price_recover_targets is ordered by transaction_hash, '
  'so the window needs no sort — 95 ms, 27,194 buffers, ALL shared HIT and zero disk reads. '
  '👉 The 37,832 rows in multi-NFT txs are still inside the predicate, so this scans 47,691 to return '
  '9,859 and will scan 47,691 to return none once drained. Re-classifying them (that is what the EMPTY '
  'unmapped_sales_resolution_failures table is for) is the follow-up, and it is a data mutation that '
  'deserves its own change.';

DO $mig$
DECLARE
  v_rows int;
  v_multi int;
  v_total bigint;
  v_singletons bigint;
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

  -- POSITIVE CONTROL: it must actually return a full batch. A picker that returns nothing would
  -- satisfy the purity check below vacuously.
  SELECT count(*) INTO v_rows FROM public.claim_allday_v1_price_recovery_candidates(200);
  IF v_rows <> 200 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 200 candidates, got %', v_rows;
  END IF;

  -- PURITY, asserted as an ABSENCE: not one returned row may belong to a multi-NFT tx. This is the
  -- property the route was discarding 999 rows a tick to enforce by hand.
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

  -- SIZE OF THE PRIZE, recorded at apply time so the ledger's number is not a re-quote.
  SELECT count(*), count(*) FILTER (WHERE n = 1) INTO v_total, v_singletons
  FROM (
    SELECT transaction_hash, count(*) AS n FROM public.unmapped_sales
    WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND resolved_at IS NULL
      AND resolution_hint->>'price_extraction' = 'v1_tx_decode_budget_exhausted'
    GROUP BY 1
  ) g;

  RAISE NOTICE 'post-state ok: 200/200 claimed, 0 from multi-NFT txs; % txs total, % singleton',
    v_total, v_singletons;
END
$mig$;
