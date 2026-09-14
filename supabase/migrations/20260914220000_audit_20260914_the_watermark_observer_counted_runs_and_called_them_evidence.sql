-- ─────────────────────────────────────────────────────────────────────────────
-- The watermark observer counted RUNS and called them EVIDENCE.
--
-- `observations` incremented on EVERY run whether or not the cursor had moved,
-- so the instrument read "165 observations, 0 ever_decreased" — which looks like
-- strong evidence that this estate has no backward-walking cursor. It was not
-- evidence of anything: all 33 rows held the identical block they were seeded
-- with, because the subject ticks every 3 h at :34 and the observer every 2 h at
-- :12, and no subject tick had yet landed between two observations.
--
-- ⭐ A zero is only interpretable next to the count of things that could have made
-- it non-zero. `changes_observed` counts observations in which last_seen_block
-- ACTUALLY MOVED. ever_decreased = 0 while changes_observed = 0 means the
-- instrument has seen nothing — not that the estate is clean. This is the
-- repo's own rule ("a permanently-zero instrument is indistinguishable from a
-- broken one") applied to an instrument shipped four hours earlier.
--
-- ⚠ Direction-agnostic ON PURPOSE: an ASCENT is evidence too. Only a cursor that
-- has been seen to MOVE could ever have been seen to DESCEND, so counting both
-- directions is what makes the discriminator honest.
--
-- Positive control run before shipping (scratch table, both directions):
--   static   → observations 2, changes 0, not armed  (no false evidence)
--   descends → observations 2, changes 1, ARMED
--   ascends  → observations 2, changes 1, not armed  (evidence without arming)
--
-- anon-exec: observe_event_cursor_watermarks -- unchanged; CREATE OR REPLACE does not reset a function ACL, and this is a body edit, so it must not add a revoke.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.event_cursor_watermarks
  ADD COLUMN IF NOT EXISTS changes_observed integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.event_cursor_watermarks.changes_observed IS
  'Observations in which last_seen_block actually CHANGED. `observations` counts RUNS; this counts EVIDENCE. ever_decreased=false is uninterpretable while this is 0.';

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
      low_water, high_water, ever_decreased, observations, changes_observed, observed_at
    )
    SELECT c.id, c.last_processed_block, c.updated_at,
           c.last_processed_block, c.last_processed_block, false, 1, 0, now()
      FROM public.event_cursor c
     WHERE c.last_processed_block IS NOT NULL
    ON CONFLICT (cursor_id) DO UPDATE SET
      -- ⚠ Order matters: every branch below reads w.* (the PRE-update row) and
      -- EXCLUDED.* (the fresh observation). ever_decreased must be evaluated from
      -- the OLD flag, and the rewind test must use the OLD flag too — a descent
      -- and a rewind cannot both happen in one observation, but reading the new
      -- value here would make that assumption load-bearing instead of incidental.
      ever_decreased   = w.ever_decreased OR EXCLUDED.last_seen_block < w.last_seen_block,
      rewind_count     = w.rewind_count
                         + CASE WHEN w.ever_decreased
                                 AND EXCLUDED.last_seen_block > w.last_seen_block
                                THEN 1 ELSE 0 END,
      last_rewind_at   = CASE WHEN w.ever_decreased
                               AND EXCLUDED.last_seen_block > w.last_seen_block
                              THEN now() ELSE w.last_rewind_at END,
      last_rewind_from = CASE WHEN w.ever_decreased
                               AND EXCLUDED.last_seen_block > w.last_seen_block
                              THEN w.last_seen_block ELSE w.last_rewind_from END,
      last_rewind_to   = CASE WHEN w.ever_decreased
                               AND EXCLUDED.last_seen_block > w.last_seen_block
                              THEN EXCLUDED.last_seen_block ELSE w.last_rewind_to END,
      low_water        = least(w.low_water, EXCLUDED.last_seen_block),
      high_water       = greatest(w.high_water, EXCLUDED.last_seen_block),
      last_seen_block  = EXCLUDED.last_seen_block,
      last_seen_cursor_updated_at = EXCLUDED.last_seen_cursor_updated_at,
      observations     = w.observations + 1,
      -- `observations` counts RUNS. This counts EVIDENCE: only an observation in
      -- which the block actually moved could ever have set ever_decreased.
      changes_observed = w.changes_observed
                         + CASE WHEN EXCLUDED.last_seen_block <> w.last_seen_block
                                THEN 1 ELSE 0 END,
      observed_at      = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_observed FROM upserted;

  SELECT count(*) FILTER (WHERE ever_decreased),
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

DO $verify$
DECLARE
  d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='observe_event_cursor_watermarks';

  IF position('changes_observed' IN d) = 0 THEN
    RAISE EXCEPTION 'observer did not gain changes_observed';
  END IF;
  -- The rewind machinery must have survived this full-body write.
  IF position('last_rewind_from' IN d) = 0 OR position('ever_decreased' IN d) = 0 THEN
    RAISE EXCEPTION 'observer lost its rewind machinery';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='event_cursor_watermarks'
                   AND column_name='changes_observed') THEN
    RAISE EXCEPTION 'changes_observed column missing';
  END IF;
END
$verify$;
