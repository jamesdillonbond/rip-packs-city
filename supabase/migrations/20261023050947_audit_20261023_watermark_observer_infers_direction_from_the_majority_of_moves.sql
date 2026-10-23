-- audit_20261023_watermark_observer_infers_direction_from_the_majority_of_moves
--
-- WHY. The rewind arm inferred a cursor's direction from ONE event: "ever observed to
-- DECREASE ⇒ backward-walking ⇒ every later INCREASE is a rewind." That is right for
-- the sales-history backfills it was built for (they only ever descend), and wrong for
-- a FORWARD walker whose owner re-seeds it LOWER on a schedule. `topshot_missing_fill_
-- offers_walk` walks UP from a start block and is re-seeded to the mainnet27 root
-- every Monday by its weekly workflow (known-issues #189, 2026-10-19 read); after the
-- first weekly re-seed the observer marked it `ever_decreased` and has counted its
-- ordinary upward progress as "rewinds" since (rewind_count 2 on 10-22; the 10-19
-- 158,890,658 → 168,305,306 step was the walk reading toward the sealed tip). Left
-- alone, `check_backward_cursor_rewind()` would light for 30 days after every Monday
-- — a permanently-lit instrument, which this repo's own rule says is indistinguishable
-- from a broken one, and three daytime-monitor filings (10-20T2110Z, 10-21T0315Z,
-- 10-22T0313Z) have already re-read and re-dismissed the same row.
--
-- WHAT. Direction is now inferred from the MAJORITY of observed moves, not the first
-- descent: two new counters, `increases` and `decreases`, and a cursor is treated as
-- backward-walking (so an increase is a rewind) only while `decreases > increases`.
--   • a sales-history backfill (every move a descent) arms on its first observed
--     descent, exactly as before (decreases 1 > increases 0);
--   • a forward walker re-seeded weekly (one descent per many ascents) never arms;
--   • a backward walker that is DELIBERATELY re-seeded upward is still flagged —
--     the original design's choice, kept: "dismiss it by recording why".
-- `ever_decreased` is kept as a fact column (it still says what it said) but no
-- longer arms the rewind test on its own. The one false rewind on record is cleared
-- in the same migration (`topshot_missing_fill_offers_walk`: rewind_count → 0, the
-- last_rewind_* fields → NULL), with the 10-19 state recorded in this header; its
-- counters are seeded from what is known (the one weekly descent, and the forward
-- moves `changes_observed` recorded minus it) so the cursor reads as the up-walker
-- it is from the first observation after apply. Every other row starts at 0/0 and
-- re-learns its direction within one or two observed moves.
--
-- Positive control run on a scratch Postgres before apply (scripts in the ledger entry):
--   descends 100→90→80, then 95   → decreases 2 > increases 0 → REWIND counted (as before)
--   ascends 100→110→120, re-seed 50, then 60→70 → increases 4 > decreases 1 → no rewind
--   static                        → observations 2, changes 0, no arming (unchanged)
--
-- EXIT: `check_backward_cursor_rewind()` reads [] after the next observer tick (hourly
-- :12) and STAYS [] across the Monday 10-26 ~7:23 AM PT weekly walk; the Golazos/UFC
-- sales-history cursors still read `decreases > increases` (armed) after their next
-- descent. FALSIFIER: a known descending backfill shows increases ≥ decreases while
-- its ticks descend, or a real forward jump on one of them goes uncounted.
--
-- anon-exec: observe_event_cursor_watermarks -- unchanged; CREATE OR REPLACE does not reset a function ACL, and this is a body edit, so it must not add a revoke.
-- REVERT: re-apply the body in 20260914220000 (CREATE OR REPLACE), then
--   UPDATE public.event_cursor_watermarks SET rewind_count = 2, last_rewind_at = '2026-10-19 18:12:00.156372+00',
--     last_rewind_from = 158890658, last_rewind_to = 168305306 WHERE cursor_id = 'topshot_missing_fill_offers_walk';
--   (the two new columns can stay; nothing else reads them).

ALTER TABLE public.event_cursor_watermarks
  ADD COLUMN IF NOT EXISTS increases integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS decreases integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.event_cursor_watermarks.increases IS
  'Observations in which last_seen_block ROSE. With decreases, decides the cursor''s direction by majority; a cursor is treated as backward-walking (an increase is a rewind) only while decreases > increases.';
COMMENT ON COLUMN public.event_cursor_watermarks.decreases IS
  'Observations in which last_seen_block FELL. See increases.';

CREATE OR REPLACE FUNCTION public.observe_event_cursor_watermarks()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_observed int := 0;
  v_armed    int := 0;
  v_rewinds  int := 0;
  v_moved    int := 0;
BEGIN
  WITH upserted AS (
    INSERT INTO public.event_cursor_watermarks AS w (
      cursor_id, last_seen_block, last_seen_cursor_updated_at,
      low_water, high_water, ever_decreased, observations, changes_observed, increases, decreases, observed_at
    )
    SELECT c.id, c.last_processed_block, c.updated_at,
           c.last_processed_block, c.last_processed_block, false, 1, 0, 0, 0, now()
      FROM public.event_cursor c
     WHERE c.last_processed_block IS NOT NULL
    ON CONFLICT (cursor_id) DO UPDATE SET
      -- ⚠ Order matters: every branch below reads w.* (the PRE-update row) and
      -- EXCLUDED.* (the fresh observation). The direction test uses the OLD
      -- counters — a descent and a rewind cannot both happen in one observation,
      -- but reading the new values here would make that assumption load-bearing
      -- instead of incidental.
      -- 2026-10-23: a cursor is backward-walking by MAJORITY of its observed moves
      -- (w.decreases > w.increases), not by having ever been seen to descend once —
      -- a forward walker re-seeded lower by its owner used to arm for good.
      ever_decreased   = w.ever_decreased OR EXCLUDED.last_seen_block < w.last_seen_block,
      increases        = w.increases + CASE WHEN EXCLUDED.last_seen_block > w.last_seen_block THEN 1 ELSE 0 END,
      decreases        = w.decreases + CASE WHEN EXCLUDED.last_seen_block < w.last_seen_block THEN 1 ELSE 0 END,
      rewind_count     = w.rewind_count
                         + CASE WHEN w.decreases > w.increases
                                 AND EXCLUDED.last_seen_block > w.last_seen_block
                                THEN 1 ELSE 0 END,
      last_rewind_at   = CASE WHEN w.decreases > w.increases
                               AND EXCLUDED.last_seen_block > w.last_seen_block
                              THEN now() ELSE w.last_rewind_at END,
      last_rewind_from = CASE WHEN w.decreases > w.increases
                               AND EXCLUDED.last_seen_block > w.last_seen_block
                              THEN w.last_seen_block ELSE w.last_rewind_from END,
      last_rewind_to   = CASE WHEN w.decreases > w.increases
                               AND EXCLUDED.last_seen_block > w.last_seen_block
                              THEN EXCLUDED.last_seen_block ELSE w.last_rewind_to END,
      low_water        = least(w.low_water, EXCLUDED.last_seen_block),
      high_water       = greatest(w.high_water, EXCLUDED.last_seen_block),
      last_seen_block  = EXCLUDED.last_seen_block,
      last_seen_cursor_updated_at = EXCLUDED.last_seen_cursor_updated_at,
      observations     = w.observations + 1,
      -- `observations` counts RUNS. This counts EVIDENCE: only an observation in
      -- which the block actually moved could ever have set a direction.
      changes_observed = w.changes_observed
                         + CASE WHEN EXCLUDED.last_seen_block <> w.last_seen_block
                                THEN 1 ELSE 0 END,
      observed_at      = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_observed FROM upserted;

  -- armed = backward-walking by majority of observed moves (the population the rewind test applies to).
  SELECT count(*) FILTER (WHERE decreases > increases),
         count(*) FILTER (WHERE rewind_count > 0),
         count(*) FILTER (WHERE changes_observed > 0)
    INTO v_armed, v_rewinds, v_moved
    FROM public.event_cursor_watermarks;

  -- ⚠ Report the count INSPECTED, not only the count that fired. A zero here is
  -- a broken observer, and is indistinguishable from a healthy estate otherwise.
  -- cursors_that_have_moved is the discriminator for armed_backward_cursors = 0.
  RETURN jsonb_build_object(
    'ok', true,
    'observed', v_observed,
    'armed_backward_cursors', v_armed,
    'cursors_with_a_rewind', v_rewinds,
    'cursors_that_have_moved', v_moved
  );
END;
$function$;

COMMENT ON FUNCTION public.observe_event_cursor_watermarks() IS
  'Takes one observation of every public.event_cursor row into event_cursor_watermarks. '
  'Infers direction from the MAJORITY of observed moves (decreases > increases ⇒ backward-walking), '
  'and an increase on a backward-walking cursor is counted as a REWIND. Returns the counts it '
  'inspected, not only what fired. Called DIRECTLY by pg_cron (no pg_net).';

COMMENT ON TABLE public.event_cursor_watermarks IS
  'One row per public.event_cursor id. A cursor is BACKWARD-walking while decreases > increases '
  '(inferred from observed deltas, never from a name or a curated list); for those, an '
  'increase is a REWIND and is counted here. ever_decreased is kept as a fact and no longer arms '
  'the test on its own (2026-10-23). Maintained by observe_event_cursor_watermarks(), read by '
  'check_backward_cursor_rewind().';

-- The one false rewind on record (header): the forward walker's weekly re-seed. Seed its
-- counters from what is known — one descent (the 10-19 re-seed) and the rest of its
-- recorded moves upward — and clear the rewind it never had.
UPDATE public.event_cursor_watermarks
   SET rewind_count = 0,
       last_rewind_at = NULL,
       last_rewind_from = NULL,
       last_rewind_to = NULL,
       decreases = 1,
       increases = GREATEST(changes_observed - 1, 0)
 WHERE cursor_id = 'topshot_missing_fill_offers_walk'
   AND rewind_count = 2
   AND last_rewind_to = 168305306;

DO $verify$
DECLARE
  d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='observe_event_cursor_watermarks';
  IF position('w.decreases > w.increases' IN d) = 0 THEN
    RAISE EXCEPTION 'observer did not gain the majority-direction test';
  END IF;
  IF position('last_rewind_from' IN d) = 0 OR position('changes_observed' IN d) = 0 THEN
    RAISE EXCEPTION 'observer lost its rewind machinery or its evidence counter';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='event_cursor_watermarks'
                   AND column_name IN ('increases','decreases') HAVING count(*) = 2) THEN
    RAISE EXCEPTION 'increases/decreases columns missing';
  END IF;
END
$verify$;
