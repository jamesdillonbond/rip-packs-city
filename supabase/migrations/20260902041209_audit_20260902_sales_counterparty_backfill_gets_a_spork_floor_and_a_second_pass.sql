-- audit_20260902_sales_counterparty_backfill_gets_a_spork_floor_and_a_second_pass
-- anon-exec: claim_sales_counterparty_batch — SECURITY DEFINER, service_role-only, identical
-- signature; CREATE OR REPLACE preserves the ACL. anon EXECUTE remains false (asserted below).
--
-- WHAT THIS FIXES — 288 runs a day, ~9.2 h of runtime, ZERO rows recovered, every instrument green.
-- `sales-counterparty-backfill` walks `sales` newest-first decoding each tx via Flow REST to recover
-- the seller. It has no LOWER bound, so it walked off the edge of what Flow REST can serve and kept
-- going. Re-derived independently before shipping (the filing is a hypothesis like any other):
--
--   cursor_sold_at at 04:07Z ................ 2023-09-23 12:30:13Z
--   runs in 24 h ............................ 288, ALL ok
--   runs with applied > 0 ................... 0
--
-- ⭐ AND THE UPSTREAM SIGNALS "I CANNOT SERVE THIS" WITH **HTTP 200**, which is why nothing caught it.
-- Past the prune horizon Flow REST answers 200 with `execution: "Pending"`, `status: ""` and ZERO
-- events. A worker that checks `res.ok`, finds no Withdraw event and advances is behaving exactly as
-- it would for a throttled miss. `res.ok` is not a liveness check.
--
-- THE WALL, BRACKETED TO A WINDOW CONTAINING NO ROWS AT ALL (pg_net from this database, 24 probes,
-- 1–3 per date, every one HTTP 200):
--
--   2023-10-05 · 11-01 · 11-03 ×3 · 11-05 ×3 · 11-07 ×3 ......... Pending, 0 events
--   2023-11-08 14:01:30Z · 14:30:16Z · 15:00:11Z · 15:58:12Z .... Pending, 0 events
--   ── the boundary is in here, and `sales` has NO row between ──
--   2023-11-08 18:51:39Z ....................................... Success, 4 events
--   2023-11-08 21:00:08Z · 11-09 ×3 · 11-10 · 11-20 · 12-10 .... Success, 4–12 events
--   2026-08-30 (positive control, same loop) ................... Success, 23 events
--
-- 15:58:12Z is the LAST `sales` row before the gap and 18:51:39Z the FIRST after it, so a floor
-- anywhere inside the gap partitions the population EXACTLY: nothing recoverable is skipped and
-- nothing pruned is attempted. **17:00:00Z is that floor.** (Flow Mainnet 25, 2023-11-08.)
--
-- ⛔ THIS SHARPENS THE FILED BRACKET AND CORRECTS A RECORDED CLAIM. The 2026-09-01T0600Z filing put
-- the wall between 2023-11-01 and 2023-11-20; it is 2023-11-08 midday. And the memory
-- `sales-counterparty-backfill-second-pass` says Flow REST has "no spork wall at this endpoint"
-- because it answered 200 back to 2024-12-31 — it does have one; **a probe that reads only the HTTP
-- status can never find this boundary, however far back it goes.**
--
-- SIZING, re-measured (null seller · in-scope collection · 64-hex hash):
--   total ...................................................... 2,308,045
--   at or above the floor — RECOVERABLE, already walked past ...   450,987  (19.5%)
--   below the floor — permanently undecodable via Flow REST .... 1,857,058  (80.5%)
--   below the CURRENT cursor — the remaining pointless grind ... 1,705,787  (~49 more days)
--
-- THE CHANGE, in the one order that is safe
--   1. `floor_sold_at` on the state row — the floor is DATA, not a literal buried in a function, so
--      an operator can move it if Flow prunes further without a migration. NOT NULL DEFAULT the
--      measured boundary, and the function still COALESCEs, so it cannot be NULLed into an
--      unbounded walk.
--   2. `claim_sales_counterparty_batch` bounds BOTH branches with `sold_at >= floor`. When the walk
--      reaches it the claim returns zero rows and the worker logs its ordinary `drained` row.
--   3. ONLY THEN the second pass: `cursor_sold_at = NULL`, re-walking the 450,987 above-floor rows
--      that were missed to throttle waves on the way down.
--
-- 🚨 STEP 3 WITHOUT STEP 2 REPRODUCES THE EXACT STATE THIS MIGRATION REMOVES — it re-attempts the
-- recoverable rows, crosses the same wall and resumes grinding. They are in one migration so the
-- ordering trap cannot be split apart by a later reader.
--
-- COST: unchanged. The worker already makes 120 × 288 = 34,560 Flow REST calls a day; after this they
-- land on rows that can answer. ~450,987 / 34,560 ≈ **13 days** to drain, then the claim goes cheap
-- and empty forever. 👉 At that point the Cloudflare cron should be slowed — an operator action
-- (`wrangler`/CF dashboard); nothing here can do it, and until then a drained tick costs one bounded
-- index range that returns nothing.
--
-- ⚠ WHAT THIS DOES NOT FIX, stated rather than implied: the WORKER still cannot tell a pruned era
-- from a throttled miss, because it reads `res.ok` and not `execution`. The floor makes that moot for
-- the boundary we measured; it does NOT protect against Flow pruning further. That fix is worker code
-- (`workers/sales-counterparty-backfill/index.ts` — treat `execution !== 'Success'` as UNREACHABLE and
-- report it in `extra`) and needs a `wrangler deploy`, which is an operator action. It is deliberately
-- NOT included here: shipping worker source that nothing deploys would put the repo ahead of what runs.
--
-- ⚠ TOOLING GOTCHA MET WHILE WRITING THIS, worth more than the SQL: `pg_get_function_identity_arguments`
-- prints `p_limit integer` and DROPS THE DEFAULT. A CREATE OR REPLACE rebuilt from it fails with
-- `42P13 cannot remove parameter defaults from existing function` — which reads like a permissions or
-- signature problem and is neither. Use `pg_get_function_arguments` (it prints `p_limit integer
-- DEFAULT 100`) whenever you are reconstructing a definition. The whole migration aborted cleanly, so
-- nothing partially applied.
--
-- REVERT (both halves, and they are independent):
--   UPDATE public.sales_counterparty_backfill_state
--      SET cursor_sold_at = '2023-09-23 12:30:13.482348+00' WHERE id = 1;
--   -- and re-apply the previous claim_sales_counterparty_batch body (no `>= v_floor` clause);
--   -- ALTER TABLE ... DROP COLUMN floor_sold_at is optional, the column is inert without the function.
-- Everything written by the second pass is fill-only and mirrored in `sales_counterparty_recovered`,
-- so it stays revertible row-by-row exactly as before.

ALTER TABLE public.sales_counterparty_backfill_state
  ADD COLUMN IF NOT EXISTS floor_sold_at timestamptz NOT NULL DEFAULT '2023-11-08T17:00:00Z';

COMMENT ON COLUMN public.sales_counterparty_backfill_state.floor_sold_at IS
  'Oldest sold_at this backfill will ever claim. Flow REST prunes history at the 2023-11-08 spork and '
  'answers HTTP 200 with execution="Pending" and zero events below it, so a status-code check cannot '
  'see the boundary. MEASURED 2026-09-02 by 24 pg_net probes: last Pending row 2023-11-08 15:58:12Z, '
  'first Success row 2023-11-08 18:51:39Z, and `sales` holds NO row between them — so 17:00:00Z '
  'partitions the population exactly. RAISE this (never lower it) if Flow prunes further; the symptom '
  'is a return to recovered=0 on ticks that still find rows.';

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
  '👉 A cursored backfill needs a FLOOR, not just a cursor: a newest-first walk otherwise terminates '
  'only by running out of data. '
  '⛔ Do not remove the floor to "reach older history" — 1,857,058 of the 2,308,045 outstanding rows '
  '(80.5%) are below it and are permanently undecodable through this endpoint. Dune '
  'flow.cadence_events is the only known path to them, and it bills on DATAPOINTS.';

DO $mig$
DECLARE
  v_floor timestamptz;
  v_below int;
  v_after int;
  v_min_after timestamptz;
BEGIN
  IF has_function_privilege('anon', 'public.claim_sales_counterparty_batch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon gained EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.claim_sales_counterparty_batch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: service_role LOST EXECUTE — the worker would 403';
  END IF;

  SELECT floor_sold_at INTO v_floor FROM public.sales_counterparty_backfill_state WHERE id = 1;
  IF v_floor IS NULL THEN
    RAISE EXCEPTION 'POST-STATE FAILED: floor_sold_at is NULL on the state row';
  END IF;

  -- BEHAVIOURAL PROOF THE FLOOR BINDS, taken with the cursor still where the walk actually was.
  -- This is the state that produced 288 zero-yield runs; the claim must now return NOTHING for it.
  SELECT count(*) INTO v_below FROM public.claim_sales_counterparty_batch(50);
  IF v_below <> 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the claim returned % rows from BELOW the floor', v_below;
  END IF;

  -- THE SECOND PASS. Deliberately after the proof above, never before it.
  UPDATE public.sales_counterparty_backfill_state
     SET cursor_sold_at = NULL, updated_at = now()
   WHERE id = 1;

  -- POSITIVE CONTROL — the other direction, so the check cannot pass by returning nothing twice.
  SELECT count(*), min(sold_at) INTO v_after, v_min_after
  FROM public.claim_sales_counterparty_batch(50);
  IF v_after <> 50 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: after the reset the claim returned % rows, expected 50', v_after;
  END IF;
  IF v_min_after < v_floor THEN
    RAISE EXCEPTION 'POST-STATE FAILED: claimed a row at % which is below the floor %', v_min_after, v_floor;
  END IF;

  RAISE NOTICE 'post-state ok: floor %, 0 rows below it, 50 rows after the reset, oldest claimed %',
    v_floor, v_min_after;
END
$mig$;
