-- audit_20260913_claim_excludes_topshot_marketplace_because_the_rearm_dissolved_its_bounded_argument
--
-- ⭐ THIS OVERTURNS A DELIBERATE 2026-09-02 DECISION, AND THE REASON IS THAT THE DECISION'S OWN
-- PREMISE WAS REMOVED BY A CHANGE SHIPPED ELEVEN DAYS LATER — not because the judgement was wrong.
-- Migration 20260902053232 wrote, in these words:
--
--   ⛔ topshot_marketplace is NOT excluded, deliberately: 4,959 rows is ~41 ticks (~3.4 h) of the
--   walk and it is BOUNDED and self-limiting — unlike the 408,309 studio-history rows, which were
--   not. 👉 Exclude a population for being permanently undecodable AND large. Poor conversion
--   alone is a cost you pay once; an unbounded one is a treadmill.
--
-- "A cost you pay once" was true of a walk that runs ONCE. `20260913074912` (07:49Z today) gave the
-- claim a re-arm: on exhaustion the cursor resets to NULL and the walk restarts from the head, every
-- `rearm_after` (live value: 2 hours). **The barren block is therefore paid once per cycle, not once
-- — which is exactly the treadmill that migration told us to avoid.** The rule did not change; the
-- system did, and the earlier decision was never re-read against it. (CLAUDE.md: *a filed DECISION
-- NOT TO ACT has a shelf life, and it is the one nobody re-checks.*)
--
-- ── THE CONVERSION MEASUREMENT, RE-DERIVED RATHER THAN QUOTED (2026-09-13 ~10:3x PT) ──────────
-- The 09-02 figure was "0 of 480 attempted over 4 consecutive ticks" — a 4-tick sample. Eleven days
-- later the population itself is the measurement, and it is stronger than any sample:
--
--   topshot_marketplace rows with seller_address IS NULL, 2026 partition ....... 4,948
--   same, 2025 partition ........................................................   11
--   TOTAL ..................................................................... 4,959
--
-- **4,959 — byte-identical to the count 20260902053232 recorded eleven days ago**, over which time
-- the lane walked that date range at least twice (observed: 2026-09-12 14:00 PT and 2026-09-13
-- 09:00–10:00 PT both traversed 2026-02-23..2026-04-02 and recovered ZERO). A population that does
-- not move while the pipeline walks it is not a sample; it is the whole set, converting at 0.00%.
--
-- ⭐ POSITIVE CONTROL, IN THE SAME INSTRUMENT AND THE SAME PASSES, so the zero cannot be a broken
-- decoder: over the 24 h to 10:2x PT the lane recovered **5,507 rows** (286 ticks), including
-- **1,320 of 1,320 — 100 %** in the 03:00 PT hour at the head of the walk. And the barren stretch is
-- a property of the DATE RANGE, not of the clock: the 2026-01 range returned 1,118 and 1,095 in
-- consecutive hours on 09-12 while 2026-02-26..2026-03-26 returned 0 on BOTH passes, twenty hours
-- apart. Decoder fine; that source does not decode.
--
-- ── WHAT IT COSTS TO KEEP WALKING IT ──────────────────────────────────────────────────────────
-- 4,959 rows at the worker's 120-row batch ≈ 41 ticks, each measured at ~55,000 ms of Flow-REST
-- decode (120 decodes + a serial retry pass over every miss — and with 0 % conversion EVERY row
-- takes the retry path). That is ~38 minutes of worker time per re-arm cycle, plus 41 claim scans,
-- recovering nothing. Observed directly today: 09:00 PT 11 ticks / 1,320 found / 0 recovered, and
-- 10:00 PT the same at 0.
--
-- ── WHAT THIS CHANGES ─────────────────────────────────────────────────────────────────────────
-- One predicate, in both branches of the claim, spelled exactly like the two exclusions already
-- there so the NULL-safe property they document is preserved: a row whose `source` IS NULL is still
-- ATTEMPTED, because `IS DISTINCT FROM` yields TRUE for NULL.
--
-- ⚠ THIS IS A SKIP, NOT A DELETION. The 4,959 rows keep their NULL seller and stay in the table; a
-- future decoder that can read `topshot_marketplace` settlements gets them back by reverting this
-- one predicate. The re-test is a single query, so a later session never has to trust this header:
--
--   SELECT count(*) FROM public.sales_2026
--    WHERE seller_address IS NULL AND source = 'topshot_marketplace';   -- 4,948 on 2026-09-13
--
-- If that number has FALLEN, something now converts them and this exclusion should be reconsidered.
-- If it is unchanged, the exclusion is still correct. ⛔ Do not re-derive the decision from the
-- 09-02 header alone: its "bounded and self-limiting" argument is the one this migration retires.
--
-- ── BODY PROVENANCE ──────────────────────────────────────────────────────────────────────────
-- 🚨 The body below is built from the LIVE `pg_get_functiondef` output read minutes before applying
-- this, NOT from the repo copy, and verified mechanically: stripped of the five lines this migration
-- adds, it is line-for-line byte-identical to live (85 lines, matching length signature).
--
-- ⓘ That check surfaced a four-line difference between production and the repo: the `GET DIAGNOSTICS`
-- comment was reworded between applying `20260913074912` and committing its file, so prod and the
-- committed migration carried two wordings of the same note, 59 characters apart, logic identical.
-- ⭐ Recorded rather than dramatised, because the repo has ALREADY decided this is benign:
-- `scripts/check-db-pin-staleness.mjs` compares under TWO normalizations — whitespace-collapsed and
-- comment-stripped — and passes on either, precisely because "live prosrc is frequently
-- comment-stripped relative to the migration". Its daily CI sweep (`db-pin-staleness.yml`, 07:20
-- UTC) is live and enforcing, not soft-skipping: it FAILED at 12:46Z today ("202 pins — 201 clean,
-- 1 needing attention") on a different pin and was green again by 14:20Z. So this is a cosmetic
-- divergence the tooling deliberately tolerates, not an uncaught drift — and applying this
-- migration makes live, migration and pin textually identical again anyway.
--
-- ── REVERT ───────────────────────────────────────────────────────────────────────────────────
-- Re-apply this body with the two `AND s.source IS DISTINCT FROM 'topshot_marketplace'` lines
-- removed (one in each branch). No state, no data, no schema change — the claim is read-only over
-- `sales` and only ever touches `sales_counterparty_backfill_state`.
--
-- anon-exec: intentional — no REVOKE for claim_sales_counterparty_batch here because this is a
-- same-signature CREATE OR REPLACE, which does not reset a function ACL. Verified live BEFORE this
-- migration (anon EXECUTE false, authenticated false, service_role true) and re-verified after with
-- has_function_privilege rather than acl text.

CREATE OR REPLACE FUNCTION public.claim_sales_counterparty_batch(p_limit integer DEFAULT 100)
 RETURNS TABLE(sale_id uuid, tx_hash text, sold_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
#variable_conflict use_column
DECLARE
  v_cursor    timestamptz;
  v_floor     timestamptz;
  v_exhausted timestamptz;
  v_rearm     interval;
  v_limit     integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_found     integer := 0;
BEGIN
  SELECT st.cursor_sold_at, st.floor_sold_at, st.exhausted_at, st.rearm_after
    INTO v_cursor, v_floor, v_exhausted, v_rearm
  FROM public.sales_counterparty_backfill_state st
  ORDER BY st.id
  LIMIT 1;

  v_floor := COALESCE(v_floor, '2023-11-08T17:00:00Z'::timestamptz);
  v_rearm := COALESCE(v_rearm, interval '2 hours');

  -- EXHAUSTED + INSIDE THE COOLDOWN: return empty WITHOUT SCANNING. This is the branch that
  -- exists to be taken most of the time; every tick that lands here is a 195,564-buffer scan
  -- that did not happen.
  IF v_exhausted IS NOT NULL AND now() - v_exhausted < v_rearm THEN
    RETURN;
  END IF;

  -- RE-ARM: the cooldown has elapsed, so sweep from the newest row again. New sales arrive at
  -- the TOP and the cursor only ever descends, so this is the only way the lane can ever see
  -- them. Clearing the stamp here (not after the scan) means a scan that finds nothing will
  -- simply set it again below.
  IF v_exhausted IS NOT NULL THEN
    UPDATE public.sales_counterparty_backfill_state
       SET cursor_sold_at = NULL, exhausted_at = NULL, updated_at = now()
     WHERE id = 1;
    v_cursor := NULL;
  END IF;

  -- SELF-HEAL: a cursor STRICTLY BELOW the floor is invalid state, not a position (migration
  -- 20260902042214). Left alone it returns an empty range on every tick, forever, at ok=true.
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
        -- KNOWN-UNDECODABLE (20260913, this migration): 4,959 rows, 0.00% conversion measured as a
        -- WHOLE POPULATION over 11 days and at least two full walks, against 5,507 recovered from
        -- other sources in the same 24 h. Excluded only because the re-arm made the walk cyclic.
        AND s.source IS DISTINCT FROM 'topshot_marketplace'
      ORDER BY s.sold_at DESC
      LIMIT v_limit;
  ELSE
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
        AND s.source IS DISTINCT FROM 'topshot_marketplace'
      ORDER BY s.sold_at DESC
      LIMIT v_limit;
  END IF;

  -- GET DIAGNOSTICS AFTER `RETURN QUERY` REPORTS THE ROWS THAT QUERY ADDED TO THE RESULT SET,
  -- which is exactly what "did this scan find anything" means here. Verified on PG 16 before
  -- shipping (3 rows -> 3, empty -> 0). A zero is the drained signal - record it, so the NEXT
  -- tick takes the free branch above instead of paying for the same discovery again.
  GET DIAGNOSTICS v_found = ROW_COUNT;
  IF v_found = 0 THEN
    UPDATE public.sales_counterparty_backfill_state
       SET exhausted_at = now(), updated_at = now()
     WHERE id = 1;
  END IF;
END;
$function$;
