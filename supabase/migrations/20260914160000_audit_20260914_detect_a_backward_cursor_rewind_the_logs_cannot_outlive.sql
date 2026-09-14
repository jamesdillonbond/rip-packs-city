-- ─────────────────────────────────────────────────────────────────────────────
-- A backward-walking cursor that JUMPS FORWARD has thrown away its walk, and
-- nothing in this estate can see it three days later.
--
-- WHY NOW. `ee90eb54c` (2026-09-02) fixed the mechanism: in the five
-- *-sales-history-backfill routes a failed cursor read fell through with
-- `ceiling` still at CEILING_INIT — the TOP of the backward walk — and upserted
-- that high block back over the real cursor, silently, at ok:true. It asked
-- "Did it fire?" and answered "No evidence within retention, and retention is
-- the caveat."
--
-- ⭐ TODAY THE EVIDENCE TURNED UP OUTSIDE RETENTION, IN `event_cursor` ITSELF.
-- Both V1 sales backfills were ONE TICK from the spork floor on 2026-07-31
-- (recorded in their own suppression text: Golazos scanning 137,441,736-137,481,735,
-- UFC 137,444,766-137,484,765). Measured 2026-09-14 they sit MILLIONS of blocks
-- HIGHER, i.e. re-walking from CEILING_INIT:
--     golazos  148,721,736 - 142,481,736 = 6,240,000 = 156 ticks ~ 19.5 d -> ~08-26
--     ufc      148,804,766 - 147,644,766 = 1,160,000 =  29 ticks ~  3.6 d -> ~08-23
-- Two lanes, two independent dates, both inside the week before the fix.
-- ⚠ Best-supported explanation, not a certainty — a manual reset looks identical.
--
-- ⭐ THE TRANSFERABLE POINT, and the reason this migration exists rather than a
-- doc note: `pipeline_runs` keeps ~73 h, so the ONE query that would have caught
-- this (`cursor_after > cursor_before`) is blind to anything older than three
-- days. The cursor is a SLOWLY-MOVING state that OUTLIVES THE LOG. A watermark
-- table turns it into an instrument that remembers.
--
-- WHAT THIS INSTALLS
--   • `event_cursor_watermarks`  — one row per cursor: low/high water, whether it
--     has ever been seen to DESCEND, and the last forward jump after a descent.
--   • `observe_event_cursor_watermarks()` — the writer. pg_cron calls it DIRECTLY
--     (no HTTP, no pg_net: pg_net answers a batch when its slowest member
--     finishes, which is what made jobid 55 head-of-line block the platform).
--   • `check_backward_cursor_rewind()` — the read-side guard, ban at zero.
--
-- ⚠ SELF-REGISTERING, NOT A CURATED LIST. Direction is inferred from the data:
-- a cursor that has ever been observed to DECREASE walks backward, and for those
-- an INCREASE is a rewind. A forward indexer only ever increases, so it can
-- never enter the population — no allowlist to rot, no name pattern to drift.
--
-- ⚠ WHAT IT IS STRUCTURALLY SILENT ABOUT, stated now rather than discovered
-- later: a lane arms the FIRST TIME it is observed descending. At install every
-- row reads `ever_decreased = false`, so the detector is blind for one
-- observation per lane — Golazos ticks every 3 h and arms within one cycle, and
-- a DORMANT backfill never arms at all (it cannot rewind without a caller, and
-- the first descending tick after a caller returns arms it). It also cannot see
-- a rewind that happened BEFORE install; the two above are recorded in the
-- suppression reasons and in the ledger instead.
--
-- ⚠ A DELIBERATE re-seed of a backfill cursor WILL be flagged. That is correct:
-- it is indistinguishable from the defect by state alone, which is exactly this
-- repo's own rule. Dismiss it by recording why, not by widening the check.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.event_cursor_watermarks (
  cursor_id                   text PRIMARY KEY,
  first_seen_at               timestamptz NOT NULL DEFAULT now(),
  last_seen_block             bigint      NOT NULL,
  last_seen_cursor_updated_at timestamptz,
  low_water                   bigint      NOT NULL,
  high_water                  bigint      NOT NULL,
  ever_decreased              boolean     NOT NULL DEFAULT false,
  observations                integer     NOT NULL DEFAULT 1,
  rewind_count                integer     NOT NULL DEFAULT 0,
  last_rewind_at              timestamptz,
  last_rewind_from            bigint,
  last_rewind_to              bigint,
  observed_at                 timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.event_cursor_watermarks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.event_cursor_watermarks FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.event_cursor_watermarks IS
  'One row per public.event_cursor id. ever_decreased marks a BACKWARD-walking cursor '
  '(inferred from observed deltas, never from a name or a curated list); for those, an '
  'increase is a REWIND and is counted here. Maintained by '
  'observe_event_cursor_watermarks(), read by check_backward_cursor_rewind(). '
  'A lane arms the first time it is observed descending, so a dormant backfill never arms.';

-- ── the writer ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.observe_event_cursor_watermarks()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_observed int := 0;
  v_armed    int := 0;
  v_rewinds  int := 0;
BEGIN
  WITH upserted AS (
    INSERT INTO public.event_cursor_watermarks AS w (
      cursor_id, last_seen_block, last_seen_cursor_updated_at,
      low_water, high_water, ever_decreased, observations, observed_at
    )
    SELECT c.id, c.last_processed_block, c.updated_at,
           c.last_processed_block, c.last_processed_block, false, 1, now()
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
      observed_at      = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_observed FROM upserted;

  SELECT count(*) FILTER (WHERE ever_decreased),
         count(*) FILTER (WHERE rewind_count > 0)
    INTO v_armed, v_rewinds
    FROM public.event_cursor_watermarks;

  -- ⚠ Report the count INSPECTED, not only the count that fired. A zero here is
  -- a broken observer, and is indistinguishable from a healthy estate otherwise.
  RETURN jsonb_build_object(
    'ok', true,
    'observed', v_observed,
    'armed_backward_cursors', v_armed,
    'cursors_with_a_rewind', v_rewinds
  );
END;
$function$;

-- anon-exec: NOT intentional — ops writer, revoked below (observe_event_cursor_watermarks)
REVOKE EXECUTE ON FUNCTION public.observe_event_cursor_watermarks() FROM PUBLIC, anon, authenticated;
-- ⚠ The REVOKE above orphans the pg_cron caller unless the job's role is named
-- explicitly — SECURITY DEFINER says what it RUNS AS, never who may CALL it, and
-- that failure mode is SILENCE (cron.job_run_details shows it; pipeline_runs never does).
GRANT EXECUTE ON FUNCTION public.observe_event_cursor_watermarks() TO postgres, service_role;

COMMENT ON FUNCTION public.observe_event_cursor_watermarks() IS
  'Takes one observation of every public.event_cursor row into event_cursor_watermarks. '
  'Infers direction from observed deltas: a decrease arms ever_decreased, and an increase '
  'on an armed cursor is counted as a REWIND. Returns the counts it inspected, not only '
  'what fired. Called DIRECTLY by pg_cron (no pg_net) every 2 h.';

-- ── the read-side guard ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_backward_cursor_rewind()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'kind', 'backward_cursor_rewound',
           'cursor_id', w.cursor_id,
           'rewound_at', w.last_rewind_at,
           'from_block', w.last_rewind_from,
           'to_block', w.last_rewind_to,
           'blocks_discarded', w.last_rewind_to - w.last_rewind_from,
           'low_water', w.low_water,
           'rewind_count', w.rewind_count,
           'detail', 'This cursor has been observed walking DOWN, so an increase discards '
                  || 'walk progress that nothing re-walks. It jumped '
                  || (w.last_rewind_to - w.last_rewind_from) || ' blocks forward, from '
                  || w.last_rewind_from || ' to ' || w.last_rewind_to || '. Its lowest '
                  || 'observed position was ' || w.low_water || '. Either a cursor write '
                  || 'regressed (the class ee90eb54c fixed on 2026-09-02) or someone '
                  || 're-seeded it deliberately — both look identical from the state alone, '
                  || 'so establish which before dismissing this.'
         ) ORDER BY w.last_rewind_at DESC), '[]'::jsonb)
    FROM public.event_cursor_watermarks w
   WHERE w.rewind_count > 0
     AND w.last_rewind_at > now() - interval '30 days';
$function$;

-- anon-exec: NOT intentional — ops-only guard, revoked below (check_backward_cursor_rewind)
REVOKE EXECUTE ON FUNCTION public.check_backward_cursor_rewind() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_backward_cursor_rewind() TO postgres, service_role;

COMMENT ON FUNCTION public.check_backward_cursor_rewind() IS
  'Ban at zero: a cursor observed walking DOWN must not jump UP. Returns a jsonb ARRAY — '
  'clean is jsonb_array_length() = 0, NOT count(*) = 1. Window is 30 days so a rewind does '
  'not page forever; the watermark row keeps rewind_count indefinitely. Blind for one '
  'observation per lane after install (nothing is armed until a descent is seen) and blind '
  'to anything before install.';

-- ── seed the first observation + the schedule ────────────────────────────────
SELECT public.observe_event_cursor_watermarks();

SELECT cron.schedule('rpc-observe-cursor-watermarks', '12 */2 * * *',
                     $$SELECT public.observe_event_cursor_watermarks();$$);

-- ── verification, same transaction ───────────────────────────────────────────
DO $verify$
DECLARE
  v_rows int;
  v_cursors int;
BEGIN
  SELECT count(*) INTO v_rows    FROM public.event_cursor_watermarks;
  SELECT count(*) INTO v_cursors FROM public.event_cursor WHERE last_processed_block IS NOT NULL;
  IF v_rows <> v_cursors THEN
    RAISE EXCEPTION 'seed observed % of % cursors', v_rows, v_cursors;
  END IF;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'seed observed nothing — a zero-population observer is indistinguishable from a broken one';
  END IF;
  IF jsonb_array_length(public.check_backward_cursor_rewind()) <> 0 THEN
    RAISE EXCEPTION 'guard is not clean at install: %', public.check_backward_cursor_rewind()::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-observe-cursor-watermarks' AND active) THEN
    RAISE EXCEPTION 'observer is not scheduled';
  END IF;
END
$verify$;

-- REVERT (all four parts):
--   SELECT cron.unschedule('rpc-observe-cursor-watermarks');
--   DROP FUNCTION public.check_backward_cursor_rewind();
--   DROP FUNCTION public.observe_event_cursor_watermarks();
--   DROP TABLE public.event_cursor_watermarks;
