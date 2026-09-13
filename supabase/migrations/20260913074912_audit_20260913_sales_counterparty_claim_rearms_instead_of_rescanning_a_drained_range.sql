-- `sales-counterparty-backfill` re-stranded itself below its own work within SIX HOURS of the
-- 2026-09-12 cursor reset, and has spent every tick since re-deriving the same zero.
--
-- ── MEASURED 2026-09-13 00:3x–01:0x PT, LIVE ──────────────────────────────────────────────
--   cursor_sold_at = 2024-04-19 09:32:49.894839+00  -- byte-identical to the value migration
--                                                   -- 20260912192653 reset AWAY from
--   updated_at     = 2026-09-13 01:33Z              -- last time it moved
--   pipeline_runs, 02:00Z..07:00Z: 12 runs/hour, rows_found 0, rows_written 0, SIX HOURS
--   eligible rows ABOVE that cursor: >= 5,000 (bounded count, capped at 5,000 and hit the cap)
--
-- ⭐ SO THE LANE IS NOT EXHAUSTED, IT IS STRANDED — the same diagnosis the 2026-09-12T0117Z
-- filing's own correction reached, now observed RECURRING on a six-hour cycle. That filing
-- predicted it in writing ("the cursor will descend back into the exhausted zone"); this is
-- that prediction turning into a measurement, which is the only reason to act rather than
-- re-file.
--
-- ⭐ AND THE RESET WAS PRODUCTIVE WHILE IT LASTED, which is the evidence that re-arming is
-- worth doing rather than merely cheap: between 19:00Z and 01:00Z the lane recovered
-- 3,548 rows (rows_written by hour: 665, 0, 0, 92, 1118, 1095, 578) and then stopped dead.
-- `seller_address` feeds wallet pages, buyer analytics, top-buyer boards and the insider
-- detectors, so these are not decorative rows.
--
-- ── THE COST OF THE STRANDED STATE ────────────────────────────────────────────────────────
-- The below-cursor range is 100% `*_studio_history_v1` rows, which the claim excludes by
-- design. So every tick delivers ~221,183 rows through the partial index and discards all of
-- them in a post-Filter: 195,564 buffers, 4.3 s WARM on an idle instance (2026-09-11 addendum,
-- measured with BUFFERS). The worker's cron is `*/5 * * * *` = 288 ticks/day. Under load that
-- scan exceeds the 60 s statement_timeout, which is the lane's 36–47 % failure rate — every
-- failure the identical `claim failed: canceling statement due to statement timeout`.
--
-- ── WHAT THIS CHANGES ─────────────────────────────────────────────────────────────────────
-- The claim function gains an EXHAUSTED state, which is recommendation (1) of that filing's
-- addendum, in its own words: "give the lane a terminal/exhausted state ... rather than
-- re-deriving the same zero 286 times a day".
--
--   1. A scan that returns ZERO now RECORDS that fact (`exhausted_at = now()`).
--   2. While `exhausted_at` is inside `rearm_after`, the function returns empty IMMEDIATELY
--      AND SCANS NOTHING. ⭐ This is the whole saving: the 195,564-buffer scan happens once
--      per cycle instead of 288 times a day.
--   3. When `rearm_after` elapses, the cursor is set back to NULL and the next scan starts
--      from the TOP — where the >= 5,000 eligible rows actually are. The function's existing
--      `cursor IS NULL` branch already does exactly this and was measured at ~5,085 buffers,
--      i.e. ~38x cheaper than the stranded scan it replaces.
--
-- ⚠ STABLE -> VOLATILE, deliberately and unavoidably. The function must record the exhausted
-- stamp, and a STABLE function cannot write. The caller is `workers/sales-counterparty-backfill`
-- via supabase-js `.rpc()`, which POSTs, so nothing about the call site changes.
--
-- ⛔ WHY THE FIX IS NOT IN THE WORKER, WHERE IT ARGUABLY BELONGS. The worker ALREADY detects
-- this state — it logs `{note: "drained", batch: 0}` — and does nothing with it, so a
-- three-line change there would be the obvious home. It is a CLOUDFLARE WORKER and this
-- session cannot deploy one (no wrangler auth; and this repo records that a `wrangler deploy`
-- has silently DELETED a cron before). A DB-side fix needs no deploy and no worker change:
-- the worker keeps calling the same RPC with the same signature and gets an empty array, which
-- is a case it already handles.
--
-- ⛔ WHAT I DELIBERATELY DID NOT DO, having checked rather than assumed:
--   (a) NO INDEX ON `sales_2026`. Every partition 2020–2025 has an `…_nullseller_soldat`
--       partial index and 2026 does not, which reads like an oversight from the partition
--       rotation. It is not — migration 20260724150000 states the decision explicitly:
--       "sales_2026 is deliberately NOT indexed here: it is the active-ingest partition
--       (adding an index there costs write-amplification on the hottest write path) and it
--       already has sales_2026_seller_address_idx which the plan uses cheaply." Do not
--       "restore" it.
--   (b) NO `source` PREDICATE ADDED TO THE OLDER PARTIAL INDEXES. That is the filing's
--       recommendation (2) and it is explicitly ranked BELOW this one by its own author,
--       because "a perfect index makes each tick find nothing FAST instead of finding nothing
--       SLOWLY — the waste becomes cheap and permanent rather than expensive and permanent".
--       With the exhausted state the stranded scan runs a handful of times a day, so the
--       index's remaining value is small and an index build is itself heavy IO on a 2-core
--       instance. Revisit only if the post-fix measurement says otherwise.
--   (c) NO RAISING OF `floor_sold_at`. The filing works through why that backfires (the
--       self-heal converts a cursor below the floor into a NULL cursor and re-walks upward).
--
-- ⚠ KNOWN AND FILED, NOT FIXED HERE — the re-arm will re-attempt rows that were already tried
-- and could not be decoded, because nothing records a per-row attempt. The cursor advances past
-- undecodable rows (apply_sales_counterparty takes `min(sold_at)` of the batch regardless of
-- success), so those rows stay NULL-seller above the cursor forever and every re-arm meets them
-- again. That costs upstream decode calls, not DB IO, and fixing it needs a per-row attempt
-- marker — a bigger change that wants its own measurement of how many of the >= 5,000 are
-- genuinely new arrivals versus permanent misses. Recorded in the register rather than guessed
-- at here. `rearm_after` is the knob that bounds the cost meanwhile.
--
-- EXIT CONDITION (first 24 h): `extra.note = 'exhausted_cooldown'` rows appear and dominate the
-- tick mix; `rows_found > 0` returns in bursts every `rearm_after`; the `canceling statement due
-- to statement timeout` failures fall toward zero.
-- FALSIFIER: if `rows_found` stays 0 across a full re-arm (i.e. a top-scan finds nothing), then
-- the >= 5,000 rows are NOT reachable from the top branch and this diagnosis is wrong — revert
-- and re-measure before trying anything else.
--
-- REVERT (restores the exact prior behaviour; the columns are additive and can stay):
--   -- 1. restore the STABLE, non-re-arming body from migration 20260902050149, then:
--   UPDATE public.sales_counterparty_backfill_state SET exhausted_at = NULL WHERE id = 1;
--   -- (the pre-change cursor was 2024-04-19 09:32:49.894839+00; the re-arm will have moved it)
--
-- anon-exec: intentional — no REVOKE for claim_sales_counterparty_batch here because this is a
-- same-signature CREATE OR REPLACE, which does not reset a function ACL. Verified live BEFORE
-- this migration (anon EXECUTE false, authenticated false, service_role true) and re-verified
-- after with has_function_privilege rather than acl text.

ALTER TABLE public.sales_counterparty_backfill_state
  ADD COLUMN IF NOT EXISTS exhausted_at timestamptz,
  ADD COLUMN IF NOT EXISTS rearm_after  interval NOT NULL DEFAULT '2 hours';

COMMENT ON COLUMN public.sales_counterparty_backfill_state.exhausted_at IS
  'Set when a claim scan returned ZERO rows. While now() - exhausted_at < rearm_after the '
  'claim returns empty WITHOUT SCANNING, which is what stops a drained range being re-walked '
  '288 times a day. Cleared by the re-arm, which also sets cursor_sold_at back to NULL.';

COMMENT ON COLUMN public.sales_counterparty_backfill_state.rearm_after IS
  'How long a drained lane stays quiet before sweeping again from the newest row. The knob '
  'that bounds how often already-attempted-and-undecodable rows are re-tried upstream. '
  'Tune with a plain UPDATE; no deploy and no migration needed.';

CREATE OR REPLACE FUNCTION public.claim_sales_counterparty_batch(p_limit integer DEFAULT 100)
 RETURNS TABLE(sale_id uuid, tx_hash text, sold_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
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
      ORDER BY s.sold_at DESC
      LIMIT v_limit;
  END IF;

  -- ⚠ GET DIAGNOSTICS AFTER `RETURN QUERY` REPORTS THE ROWS THAT QUERY ADDED TO THE RESULT
  -- SET, which is exactly what "did this scan find anything" means here. A zero is the
  -- drained signal — record it, so the NEXT tick takes the free branch above instead of
  -- paying for the same discovery again.
  GET DIAGNOSTICS v_found = ROW_COUNT;
  IF v_found = 0 THEN
    UPDATE public.sales_counterparty_backfill_state
       SET exhausted_at = now(), updated_at = now()
     WHERE id = 1;
  END IF;
END;
$function$;
