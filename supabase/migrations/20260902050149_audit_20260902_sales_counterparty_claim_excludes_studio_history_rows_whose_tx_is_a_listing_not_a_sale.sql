-- audit_20260902_sales_counterparty_claim_excludes_studio_history_rows_whose_tx_is_a_listing_not_a_sale
-- anon-exec: claim_sales_counterparty_batch — SECURITY DEFINER, service_role-only, identical
-- signature; CREATE OR REPLACE preserves the ACL. anon EXECUTE remains false (asserted below).
--
-- ⛔⛔ THIS CORRECTS A NUMBER I PUBLISHED THREE MIGRATIONS AGO, AND THE ERROR IS THE ONE THIS REPO HAS
-- ALREADY WRITTEN DOWN ONCE.
--
-- `20260902041209` gave this walk a floor and said: *"450,987 (19.5%) at or above the floor —
-- RECOVERABLE."* **That figure counts rows whose TRANSACTION IS REACHABLE. It says nothing about
-- whether a seller can be DECODED from it** — which is the only thing the pipeline can actually do.
-- It is the same circular sizing the fmv-recalc filing called out on 09-01 (*"I sized a backlog using
-- the very predicate that was defining it wrongly"*), committed by the next session, in a different
-- pipeline, with the mistake's own description already in the ledger.
--
-- HOW IT SURFACED — by watching, not by re-reading. The floor fix's first tick recovered 109 of 120.
-- The next SIX recovered 0 of 720, at ~82 s each:
--
--   04:20  120 found · 109 recovered ·  37 s
--   04:25 … 04:50   120 found · 0 recovered · ~82 s each
--
-- Every row in that band is `nfl_all_day` / `allday_studio_history_v1`.
--
-- ⭐ THE CAUSE, PROBED DIRECTLY: those rows carry the **NFTStorefrontV2.ListingAvailable**
-- transaction, not the transfer. **21 of 21 hash-bucket-sampled txs** across
-- `allday_studio_history_v1` and `ufc_studio_history_v1` (two different bucket moduli, so not one
-- physical page) returned HTTP 200 / `execution: Success` with **ZERO
-- TopShot|AllDay|UFC_NFT Withdraw events and exactly one ListingAvailable** —
--
--   A.…NFTStorefrontV2.ListingAvailable | A.…FlowToken.TokensWithdrawn |
--   A.…FungibleToken.Deposited | A.…FlowFees.FeesDeducted
--
-- — against a **3-of-3 positive control** on `nba_top_shot` / `onchain` rows: 26 events, 1 Withdraw
-- each. **No seller exists in a listing transaction to be found**, so no number of passes recovers
-- these. ⭐ And the route already knows this shape: `lock-check-batch`'s header records that *"Golazos
-- secondary 'sales' reference ListingAvailable txs with no moment transfer, so they are not
-- claimed"*. The same defect was present for AllDay and UFC studio imports, and those WERE claimed.
--
-- THE CORRECTED SIZING, above the floor (null seller · 64-hex hash · in-scope collection):
--
--   allday_studio_history_v1 .... 297,670   ← listing txs, permanently undecodable here
--   ufc_studio_history_v1 ....... 110,639   ← same
--   nba_top_shot onchain .........  36,872   ← decodable
--   nba_top_shot topshot_marketplace  4,959  ← decodable
--   ufc_strike onchain ...........     499   ← decodable
--   nba_top_shot ts_history_backfill_v1  190 · nfl_all_day onchain_dapper_v1  49
--   ────────────────────────────────────────
--   REACHABLE 450,987 · **DECODABLE ≈ 42,569 (9.4%)** · undecodable 408,309 (90.6%)
--
-- ⛔ The floor migration's other claims stand: the wall, the bracket, the 0-of-288, the self-heal.
-- Only the size of the prize was wrong, and it was wrong by 10x in the flattering direction.
--
-- COST of the exclusion, measured rather than assumed: 455 ms / 13,943 buffers, ALL shared HIT and
-- zero disk reads, to fill a 120-row batch (bitmap scan on `sales_2026_seller_address_idx`, older
-- partitions never executed). It is more per call than the unfiltered claim — and it returns 120 rows
-- that CAN convert instead of 120 that cannot.
--
-- 👉 FOLLOW-UP, not bundled: the 408,309 undecodable rows still sit inside the predicate, so the walk
-- scans past them forever. Marking them (a `seller_unrecoverable_reason`, or the same idea as
-- `unmapped_sales_resolution_failures`) would shrink the scan. That is a 408k-row data mutation and
-- deserves its own change with its own revert path. ⚠ And if a THIRD `*_studio_history_v1` source
-- appears, probe a dozen hash-bucket-sampled txs for a Withdraw before assuming either way.
--
-- REVERT: re-apply 20260902042214's function body (identical minus the two `source NOT IN` lines).
-- No table, index, schedule or grant changes; this function only READS.

CREATE OR REPLACE FUNCTION public.claim_sales_counterparty_batch(p_limit integer DEFAULT 100)
 RETURNS TABLE(sale_id uuid, tx_hash text, sold_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
#variable_conflict use_column
DECLARE
  v_cursor timestamptz;
  v_floor  timestamptz;
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
  SELECT st.cursor_sold_at, st.floor_sold_at INTO v_cursor, v_floor
  FROM public.sales_counterparty_backfill_state st
  ORDER BY st.id
  LIMIT 1;

  -- The COALESCE is the thing that makes the floor unfalsifiable-in-the-wrong-direction: a NULL here
  -- would restore the unbounded walk this migration exists to end, silently and with every instrument
  -- still green. See the column comment for how the constant was measured.
  v_floor := COALESCE(v_floor, '2023-11-08T17:00:00Z'::timestamptz);

  -- SELF-HEAL: a cursor STRICTLY BELOW the floor is invalid state, not a position. It cannot arise
  -- from normal operation — every apply sets the cursor to min(sold_at) over a batch that was itself
  -- bounded below by the floor — so it means either a legacy value from before the floor existed or
  -- an operator raising the floor past it. Left alone it is the worst possible failure: the claim
  -- returns an empty range on every tick, forever, with ok=true, rows_found=0 and every instrument
  -- reading "drained".
  --
  -- 🚨 THIS IS NOT HYPOTHETICAL AND IT COST A TICK THE DAY THE FLOOR SHIPPED. The floor migration
  -- reset the cursor to NULL inside its transaction and its post-state assertions passed — and 42
  -- seconds later an already-in-flight worker tick, which had claimed BELOW the floor before the
  -- migration committed, wrote its own stale cursor back over the reset. The next tick found 0 rows
  -- in 514 ms and looked perfectly healthy. ⭐ A migration's post-state proves the state AT COMMIT;
  -- it cannot prove the state survived a concurrent writer. When resetting a cursor a live pipeline
  -- owns, either fence it (as this branch does) or verify a tick LATER, not at commit.
  --
  -- Restarting from the top is cheap and cannot double-work: the claim only ever returns rows whose
  -- seller is still NULL, so everything already recovered stays out of the set.
  IF v_cursor IS NOT NULL AND v_cursor < v_floor THEN
    v_cursor := NULL;
  END IF;

  IF v_cursor IS NULL THEN
    RETURN QUERY
      SELECT s.id, s.transaction_hash::text, s.sold_at
      FROM public.sales s
      WHERE s.seller_address IS NULL
        AND s.collection IN ('nba_top_shot', 'nfl_all_day', 'ufc_strike')
        AND s.transaction_hash ~ '^[0-9a-f]{64}$'
        AND s.sold_at >= v_floor
        AND s.source NOT IN ('allday_studio_history_v1', 'ufc_studio_history_v1')
      ORDER BY s.sold_at DESC
      LIMIT v_limit;
  ELSE
    -- v_cursor/v_floor are scalar params here => executor-startup partition pruning
    RETURN QUERY
      SELECT s.id, s.transaction_hash::text, s.sold_at
      FROM public.sales s
      WHERE s.seller_address IS NULL
        AND s.collection IN ('nba_top_shot', 'nfl_all_day', 'ufc_strike')
        AND s.transaction_hash ~ '^[0-9a-f]{64}$'
        AND s.sold_at < v_cursor
        AND s.sold_at >= v_floor
        AND s.source NOT IN ('allday_studio_history_v1', 'ufc_studio_history_v1')
      ORDER BY s.sold_at DESC
      LIMIT v_limit;
  END IF;
END;
$function$;


COMMENT ON FUNCTION public.claim_sales_counterparty_batch(integer) IS
  'Newest-first claim for sales-counterparty-backfill: NULL-seller rows carrying a 64-hex Flow tx '
  'hash, bounded ABOVE by state.cursor_sold_at, BELOW by state.floor_sold_at, and restricted to '
  'sources whose transaction_hash is the SALE transaction. '
  '⚠ THE FLOOR IS LOAD-BEARING (2026-09-02). Without it this walk had no lower bound and had already '
  'passed Flow REST''s prune horizon: 288 runs a day, ~10.25 h of runtime, 0 rows recovered, every '
  'instrument green — because past the horizon Flow REST answers HTTP 200 with execution="Pending" '
  'and zero events, indistinguishable from a throttled miss to a caller that checks res.ok. '
  '👉 A cursored backfill needs a FLOOR, not just a cursor. '
  '⚠ A cursor STRICTLY BELOW the floor self-heals to a restart — invalid state no normal apply can '
  'produce, and left alone every tick returns an empty range while reporting "drained". '
  '⛔ THE SOURCE EXCLUSION IS ALSO LOAD-BEARING, and it was measured, not assumed (2026-09-02). '
  'allday_studio_history_v1 and ufc_studio_history_v1 store the NFTStorefrontV2 **ListingAvailable** '
  'transaction on the sale row, not the transfer: 21 of 21 hash-bucket-sampled txs across both '
  'sources came back HTTP 200 / execution Success with ZERO TopShot|AllDay|UFC_NFT Withdraw events '
  'and exactly one ListingAvailable, against a 3-of-3 positive control on `onchain` Top Shot rows (26 '
  'events, 1 Withdraw each). No seller can ever be decoded from a listing. Live confirmation: six '
  'consecutive ticks over that band recovered 0 of 720 at ~82 s each. This is the same shape the '
  'route already excludes Golazos for. '
  '⛔ SO THE "450,987 RECOVERABLE" FIGURE IN THE FLOOR MIGRATION IS WRONG — it counted rows whose tx '
  'is REACHABLE, not rows whose seller is DECODABLE. Above the floor: 408,309 (90%) are studio-history '
  'listing rows and permanently undecodable here; the real recoverable set is ~42,569, dominated by '
  'nba_top_shot `onchain` (36,872) and `topshot_marketplace` (4,959). '
  '👉 If a THIRD `*_studio_history_v1` source appears, probe a dozen hash-bucket-sampled txs for a '
  'Withdraw event before assuming either way — and the fleet zero-yield census will surface it as a '
  'treadmill if nobody does.';

DO $mig$
DECLARE
  v_rows int;
  v_studio int;
BEGIN
  IF has_function_privilege('anon', 'public.claim_sales_counterparty_batch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon gained EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.claim_sales_counterparty_batch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: service_role LOST EXECUTE — the worker would 403';
  END IF;

  -- POSITIVE CONTROL: a full batch must still come back. An exclusion that emptied the claim would
  -- look like a drained pipeline, which is the failure mode this whole line of work is about.
  SELECT count(*) INTO v_rows FROM public.claim_sales_counterparty_batch(120);
  IF v_rows <> 120 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 120 claimed rows, got %', v_rows;
  END IF;

  -- THE PROPERTY, as an ABSENCE: not one claimed row may come from a studio-history import.
  SELECT count(*) INTO v_studio
  FROM public.claim_sales_counterparty_batch(120) c
  JOIN public.sales s ON s.id = c.sale_id
  WHERE s.source IN ('allday_studio_history_v1', 'ufc_studio_history_v1');
  IF v_studio <> 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: % of 120 claimed rows are studio-history listing rows', v_studio;
  END IF;

  RAISE NOTICE 'post-state ok: 120/120 claimed, 0 from studio-history sources';
END
$mig$;
