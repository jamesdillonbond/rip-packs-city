-- audit_20260902_claim_sales_counterparty_batch_self_heals_a_cursor_stranded_below_the_floor
-- anon-exec: claim_sales_counterparty_batch — SECURITY DEFINER, service_role-only, identical
-- signature; CREATE OR REPLACE preserves the ACL. anon EXECUTE remains false (asserted below).
--
-- 🚨 A RACE THE FLOOR MIGRATION (20260902041209) MET 42 SECONDS AFTER IT COMMITTED, and the durable
-- lesson is bigger than the fix.
--
-- That migration set `cursor_sold_at = NULL` inside its transaction and ITS POST-STATE ASSERTIONS
-- PASSED: 0 rows claimable below the floor, then 50 above it after the reset. It was correct at
-- commit. But a worker tick that started at 04:10:44 had ALREADY claimed a batch from below the
-- floor, and when it finished at 04:12:42 its `apply_sales_counterparty` wrote its own stale cursor
-- (`2023-09-23 11:45:15Z`) straight back over the reset.
--
-- The next tick then found the cursor BELOW the floor, which is an empty range, and returned
-- `rows_found: 0` in 514 ms — `ok: true`, no error, and reading exactly like a healthy drained
-- pipeline. It was caught only because the tick after the fix was actually watched.
--
-- ⭐ **A migration's post-state proves the state AT COMMIT. It cannot prove the state survived a
-- concurrent writer.** When you reset a cursor that a live pipeline owns, either fence the invalid
-- state (what this migration does) or verify a TICK LATER rather than at commit — a passing
-- post-state is not a substitute for watching the pipeline run.
--
-- THE FIX: a cursor STRICTLY BELOW the floor is treated as no cursor at all.
-- It is invalid state, not a position — no normal apply can produce it, because every apply sets the
-- cursor to `min(sold_at)` over a batch the claim already bounded below by the floor. It can only
-- come from a legacy value predating the floor, this race, or an operator raising the floor past the
-- cursor. Left alone it is the worst failure available: an empty range on every tick, forever, at
-- `ok=true` with every instrument reading "drained".
--
-- Restarting from the top is cheap and cannot double-work: the claim only ever returns rows whose
-- seller is still NULL, so everything already recovered stays out of the set.
--
-- ✅ THE FLOOR ITSELF IS VERIFIED IN PRODUCTION, one tick after it shipped:
--   04:10:44  rows_found 120 · recovered   0 · 118,188 ms · cursor 2023-09-23  (before)
--   04:20:44  rows_found 120 · recovered 109 ·  37,289 ms · cursor 2026-07-24  (after)
-- 0 of 120 across 288 consecutive runs became 109 of 120 (91%) in one tick — the ~11/12 rate the
-- worker's own header documents — and the tick got 3× faster, because rows that can answer do not
-- burn the 12 s per-call timeout.
--
-- POST-STATE HERE REPRODUCES THE FAILURE rather than describing it: the cursor is moved to exactly
-- the value the in-flight tick wrote, the claim must return 50 rows all at or above the floor, and
-- the live cursor is restored BEFORE the assertions run so a failure cannot leave the poisoned value
-- behind. A no-change control then asserts the live cursor is byte-identical to what it was.
--
-- REVERT: re-apply 20260902041209's function body (identical except for the self-heal branch).
-- No table, column, index, schedule or grant is touched by this migration.

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
      ORDER BY s.sold_at DESC
      LIMIT v_limit;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.claim_sales_counterparty_batch(integer) IS
  'Newest-first claim for sales-counterparty-backfill: NULL-seller rows carrying a 64-hex Flow tx '
  'hash, bounded ABOVE by state.cursor_sold_at and BELOW by state.floor_sold_at. '
  '⚠ THE FLOOR IS LOAD-BEARING (2026-09-02). Without it this walk had no lower bound and had already '
  'passed Flow REST''s prune horizon: 288 runs a day, ~9.2 h of runtime, 0 rows recovered, every '
  'instrument green — because past the horizon Flow REST answers HTTP 200 with execution="Pending" '
  'and zero events, which is indistinguishable from a throttled miss to a caller that checks res.ok. '
  'VERIFIED on the first tick after the fix: 109 of 120 recovered in 37 s, against 0 of 120 in 118 s. '
  '👉 A cursored backfill needs a FLOOR, not just a cursor: a newest-first walk otherwise terminates '
  'only by running out of data. '
  '⚠ A cursor STRICTLY BELOW the floor self-heals to a restart — it is invalid state that no normal '
  'apply can produce, and left alone it makes every tick return an empty range while reporting '
  '"drained". It really happened: an in-flight tick wrote its stale below-floor cursor back over the '
  'reset 42 s after the migration committed. '
  '⛔ Do not remove the floor to "reach older history" — 1,857,058 of the 2,308,045 outstanding rows '
  '(80.5%) are below it and are permanently undecodable through this endpoint. Note the floor is a '
  'property of THIS ENDPOINT, not of Flow history: 2,339 rows below it were recovered on 2026-07-19 '
  'by another path (SPORK_PROXY_URL), and Dune flow.cadence_events is the other, which bills on '
  'DATAPOINTS.';

DO $mig$
DECLARE
  v_floor timestamptz;
  v_saved timestamptz;
  v_healed int;
  v_min_healed timestamptz;
BEGIN
  IF has_function_privilege('anon', 'public.claim_sales_counterparty_batch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon gained EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.claim_sales_counterparty_batch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: service_role LOST EXECUTE — the worker would 403';
  END IF;

  SELECT cursor_sold_at, floor_sold_at INTO v_saved, v_floor
  FROM public.sales_counterparty_backfill_state WHERE id = 1;

  -- THE SELF-HEAL, PROVEN BY REPRODUCING THE FAILURE. Put the cursor exactly where the in-flight tick
  -- put it, claim, and require rows back. Before this change that state returned zero, forever.
  UPDATE public.sales_counterparty_backfill_state
     SET cursor_sold_at = '2023-09-23 11:45:15.293189+00' WHERE id = 1;

  SELECT count(*), min(sold_at) INTO v_healed, v_min_healed
  FROM public.claim_sales_counterparty_batch(50);

  -- Restore first, so a failed assertion below cannot leave the poisoned cursor behind.
  UPDATE public.sales_counterparty_backfill_state
     SET cursor_sold_at = v_saved WHERE id = 1;

  IF v_healed <> 50 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: a below-floor cursor still yields % rows, expected the self-heal to give 50', v_healed;
  END IF;
  IF v_min_healed < v_floor THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the self-heal claimed % which is below the floor %', v_min_healed, v_floor;
  END IF;

  -- NO-CHANGE CONTROL: the live cursor must be exactly what it was, and a normal claim still works.
  IF (SELECT cursor_sold_at FROM public.sales_counterparty_backfill_state WHERE id = 1) IS DISTINCT FROM v_saved THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the live cursor was not restored';
  END IF;

  RAISE NOTICE 'post-state ok: below-floor cursor self-healed to 50 rows (oldest %), live cursor restored to %',
    v_min_healed, v_saved;
END
$mig$;
