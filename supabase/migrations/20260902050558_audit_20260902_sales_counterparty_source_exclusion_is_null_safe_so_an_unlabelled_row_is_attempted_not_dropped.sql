-- audit_20260902_sales_counterparty_source_exclusion_is_null_safe_so_an_unlabelled_row_is_attempted_not_dropped
-- anon-exec: claim_sales_counterparty_batch — SECURITY DEFINER, service_role-only, identical
-- signature; CREATE OR REPLACE preserves the ACL. anon EXECUTE remains false (asserted below).
--
-- A four-minute follow-up to 20260902050149, which added
--   AND s.source NOT IN ('allday_studio_history_v1', 'ufc_studio_history_v1')
--
-- ⚠ `NOT IN` YIELDS **NULL** FOR A NULL SOURCE, AND NULL IS NOT TRUE, SO THE ROW IS EXCLUDED. That is
-- the wrong default for a claim: a writer that forgets to set `source` would have its rows vanish from
-- this backfill silently and permanently, with `rows_found` simply never counting them — the exact
-- shape of every defect fixed tonight, introduced by the fix for one of them.
--
-- `IS DISTINCT FROM` yields TRUE for NULL, so an unlabelled row is ATTEMPTED.
-- 👉 **Attempt-unless-known-undecodable is the right default for a claim**, and NULL is not knowledge.
--
-- ⚠ **THE POPULATION THIS PROTECTS IS EMPTY TODAY — 0 NULL-source rows above the floor — so nothing
-- here proves the fix works on live data.** It is prospective, the post-state RAISEs the count rather
-- than asserting it, and saying so is the point: a check that can only pass is not evidence.
--
-- REVERT: re-apply 20260902050149's body (identical apart from these two predicates). No table,
-- index, schedule or grant changes; this function only READS.

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
        -- NULL-SAFE: `NOT IN` yields NULL for a NULL source, which EXCLUDES the row. IS DISTINCT FROM
        -- yields TRUE, so an unlabelled row is ATTEMPTED. Attempt-unless-known-undecodable is the
        -- right default; the other way a new writer that forgets `source` disappears silently.
        AND s.source IS DISTINCT FROM 'allday_studio_history_v1'
        AND s.source IS DISTINCT FROM 'ufc_studio_history_v1'
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
        AND s.source IS DISTINCT FROM 'allday_studio_history_v1'
        AND s.source IS DISTINCT FROM 'ufc_studio_history_v1'
      ORDER BY s.sold_at DESC
      LIMIT v_limit;
  END IF;
END;
$function$;



DO $mig$
DECLARE
  v_rows int;
  v_studio int;
  v_null_src bigint;
BEGIN
  IF has_function_privilege('anon', 'public.claim_sales_counterparty_batch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon gained EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.claim_sales_counterparty_batch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: service_role LOST EXECUTE';
  END IF;

  SELECT count(*) INTO v_rows FROM public.claim_sales_counterparty_batch(120);
  IF v_rows <> 120 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 120 claimed rows, got %', v_rows;
  END IF;

  SELECT count(*) INTO v_studio
  FROM public.claim_sales_counterparty_batch(120) c
  JOIN public.sales s ON s.id = c.sale_id
  WHERE s.source IN ('allday_studio_history_v1', 'ufc_studio_history_v1');
  IF v_studio <> 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: % of 120 claimed rows are studio-history rows', v_studio;
  END IF;

  -- The population this change protects is EMPTY today, and saying so is the point: the fix is
  -- prospective, so nothing here can prove it works on live data. It is recorded rather than claimed.
  SELECT count(*) INTO v_null_src
  FROM public.sales
  WHERE seller_address IS NULL AND source IS NULL
    AND collection IN ('nba_top_shot', 'nfl_all_day', 'ufc_strike')
    AND transaction_hash ~ '^[0-9a-f]{64}$'
    AND sold_at >= '2023-11-08T17:00:00Z'::timestamptz;

  RAISE NOTICE 'post-state ok: 120/120 claimed, 0 studio-history; NULL-source rows above the floor today = % (prospective fix)',
    v_null_src;
END
$mig$;
