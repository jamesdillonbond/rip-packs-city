-- DB invariant: public.public_board_liveness_sweep — the probe behind the
-- `public_board_slow_count` trust arm, on pg_cron `28 */6 * * *`.
--
-- WHY IT MATTERS. This is an INSTRUMENT, and a wrong instrument is worse than no
-- instrument: the operator reads its output to decide whether a public board is
-- broken. `public_board_slow_count` is one of the four arms breached on the live
-- board as of 2026-08-15, so its classification is being acted on right now.
--
-- The invariant is the SLOW-vs-EMPTY split, and it is a real distinction rather
-- than a cosmetic one:
--   * a 57014 statement timeout means the board RENDERS, just too slowly —
--     that is a performance signal;
--   * any other error means the fail-soft page renders a BLANK board, which is
--     indistinguishable to a visitor from "no rows matched" — that is a
--     correctness signal.
-- Collapsing them makes a timing problem look like an outage or vice versa, and
-- the operator's next action differs completely.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260822203000_audit_20260822_snapshot_public_board_liveness_sweep_predictive_skip.sql).
-- Re-pinned 2026-08-22: db-pin-staleness had reported this pin STALE on every run
-- since 2026-08-10 (known-issues #24). The drift is a coherent feature, not rot —
-- least-recently-probed ROTATION, a 14-day per-board MEDIAN cost estimate, and a
-- PREDICTIVE SKIP that declines to start a board which will not fit the remaining
-- budget, plus the `skipped` counter. The slow-vs-empty split below is unchanged.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.public_board_liveness_watchlist (
  view_name text primary key,
  min_rows  bigint,
  max_ms    integer,
  is_active boolean
);

CREATE TABLE public.public_board_liveness_state (
  view_name  text primary key,
  row_count  bigint,
  elapsed_ms integer,
  err        text,
  checked_at timestamptz
);

-- The 14-day per-board MEDIAN that drives the predictive skip is read from here.
-- Left EMPTY for every assertion above: with no history the estimate falls back to
-- max_ms * 2, which fits the default budget, so the classification cases below run
-- a full sweep exactly as before. It is populated only by the last block.
CREATE TABLE public.public_board_liveness_history (
  view_name  text,
  elapsed_ms integer,
  checked_at timestamptz
);

-- >>> BEGIN verbatim public_board_liveness_sweep (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.public_board_liveness_sweep(p_budget_ms integer DEFAULT 600000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r         record;
  v_reg     regclass;
  v_cnt     bigint;
  v_whole   bigint;
  v_t0      timestamptz := clock_timestamp();
  v_tv      timestamptz;
  v_ms      integer;
  v_err     text;
  v_sqlst   text;
  v_spent   numeric;
  n_probed  integer := 0;
  n_empty   integer := 0;
  n_slow    integer := 0;
  n_skipped integer := 0;
  n_active  integer;
  v_bust    boolean := false;
BEGIN
  SELECT count(*) INTO n_active FROM public.public_board_liveness_watchlist WHERE is_active;

  FOR r IN
    WITH est AS (
      -- MEDIAN, not p90. See migration header: summing per-board p90 overstates a
      -- real sweep ~10x and would skip boards that routinely finish inside budget.
      SELECT h.view_name,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY h.elapsed_ms) AS p50_ms
        FROM public.public_board_liveness_history h
       WHERE h.checked_at > now() - interval '14 days'
         AND h.elapsed_ms IS NOT NULL
       GROUP BY h.view_name
    )
    SELECT w.view_name,
           w.min_rows,
           w.max_ms,
           COALESCE(e.p50_ms, w.max_ms * 2)::numeric AS est_ms
      FROM public.public_board_liveness_watchlist w
      LEFT JOIN public.public_board_liveness_state s ON s.view_name = w.view_name
      LEFT JOIN est e                                ON e.view_name = w.view_name
     WHERE w.is_active
     -- ROTATION: least-recently-probed first. Never-probed boards (NULL) lead.
     -- view_name is the tiebreak so the order stays deterministic within a tick.
     ORDER BY s.checked_at NULLS FIRST, w.view_name
  LOOP
    v_spent := EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000;

    IF v_spent > p_budget_ms THEN
      v_bust := true;
      EXIT;
    END IF;

    -- PREDICTIVE SKIP. A running board cannot be preempted (a per-board
    -- statement_timeout does not work: the timer is armed once at the top-level
    -- statement and is re-armed by neither SET LOCAL nor COMMIT -- both verified
    -- empirically 2026-08-16). So we decline to START a board whose median cost
    -- will not fit in what is left. The first board is exempt, which guarantees
    -- forward progress on even the most pathological view; rotation then moves it
    -- to the back of the next cycle.
    IF n_probed > 0 AND v_spent + r.est_ms > p_budget_ms THEN
      n_skipped := n_skipped + 1;
      v_bust    := true;   -- coverage is incomplete this tick; stay INCONCLUSIVE
      CONTINUE;
    END IF;

    v_cnt := NULL; v_ms := NULL; v_err := NULL; v_sqlst := NULL;
    v_reg := to_regclass('public.' || quote_ident(r.view_name));

    IF v_reg IS NULL THEN
      v_err := 'object not found in schema public';
    ELSE
      v_tv := clock_timestamp();
      BEGIN
        -- count(*) is the honest row count; count(t.*) exists ONLY to reference the whole
        -- row so the planner cannot remove the view's joins. Dropping it silently restores
        -- the false-green this migration fixes. Do not "simplify" it away.
        EXECUTE format('SELECT count(*), count(t.*) FROM %s t', v_reg) INTO v_cnt, v_whole;
        v_ms := round(EXTRACT(epoch FROM clock_timestamp() - v_tv) * 1000);
      EXCEPTION WHEN OTHERS THEN
        v_ms    := round(EXTRACT(epoch FROM clock_timestamp() - v_tv) * 1000);
        v_sqlst := SQLSTATE;
        v_err   := left(SQLSTATE || ': ' || SQLERRM, 500);
      END;
    END IF;

    INSERT INTO public.public_board_liveness_state (view_name, row_count, elapsed_ms, err, checked_at)
    VALUES (r.view_name, v_cnt, v_ms, v_err, now())
    ON CONFLICT (view_name) DO UPDATE
      SET row_count  = EXCLUDED.row_count,
          elapsed_ms = EXCLUDED.elapsed_ms,
          err        = EXCLUDED.err,
          checked_at = EXCLUDED.checked_at;

    n_probed := n_probed + 1;

    -- A TIMEOUT is SLOW, not EMPTY: the board renders, it just renders too slowly. Any other
    -- error is EMPTY, because a view that throws and a view with no rows render the identical
    -- blank board to the fail-soft page.
    IF v_sqlst = '57014' THEN
      n_slow := n_slow + 1;
    ELSIF v_err IS NOT NULL THEN
      n_empty := n_empty + 1;
    ELSE
      IF COALESCE(v_cnt, -1) < r.min_rows      THEN n_empty := n_empty + 1; END IF;
      IF COALESCE(v_ms, 0)  > r.max_ms         THEN n_slow  := n_slow  + 1; END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'probed', n_probed,
    'active', n_active,
    'skipped', n_skipped,
    'empty_or_error', n_empty,
    'slow', n_slow,
    'budget_exhausted', v_bust,
    'sweep_ms', round(EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000),
    'checked_at', now()
  );
END;
$function$;
-- <<< END verbatim public_board_liveness_sweep <<<

-- Four probe targets: healthy, empty, missing, and one that raises.
CREATE VIEW public.board_healthy AS SELECT g AS x FROM generate_series(1, 10) g;
CREATE VIEW public.board_empty   AS SELECT 1 AS x WHERE false;
CREATE VIEW public.board_raises  AS SELECT 1 / 0 AS x;

INSERT INTO public.public_board_liveness_watchlist (view_name, min_rows, max_ms, is_active) VALUES
  ('board_healthy', 1, 60000, true),
  ('board_empty',   1, 60000, true),
  ('board_raises',  1, 60000, true),
  ('board_missing', 1, 60000, true),
  ('board_paused',  1, 60000, false);

-- ── The four classifications ───────────────────────────────────────────────
SELECT _assert_eq((public.public_board_liveness_sweep() ->> 'probed'), '4',
  'the inactive watchlist row is not probed');
SELECT _assert_eq((public.public_board_liveness_sweep() ->> 'active'), '4',
  'active counts the active watchlist rows');
SELECT _assert_eq((public.public_board_liveness_sweep() ->> 'empty_or_error'), '3',
  'empty, raising, and missing all count as EMPTY — each renders a blank board');
SELECT _assert_eq((public.public_board_liveness_sweep() ->> 'slow'), '0',
  'nothing here is slow; a non-timeout error must NOT be miscounted as slow');

-- ── The state row is the operator-facing record per board ──────────────────
SELECT _assert_eq(
  (SELECT row_count::text FROM public.public_board_liveness_state WHERE view_name='board_healthy'),
  '10', 'a healthy board records its real row count');
SELECT _assert(
  (SELECT err FROM public.public_board_liveness_state WHERE view_name='board_healthy') IS NULL,
  'a healthy board records no error');
SELECT _assert_eq(
  (SELECT err FROM public.public_board_liveness_state WHERE view_name='board_missing'),
  'object not found in schema public',
  'a watchlisted view that does not exist is reported as missing, not as empty-with-no-reason');
SELECT _assert(
  (SELECT err FROM public.public_board_liveness_state WHERE view_name='board_raises') LIKE '22012:%',
  'a raising board records its SQLSTATE so the failure is diagnosable');
SELECT _assert(
  (SELECT row_count FROM public.public_board_liveness_state WHERE view_name='board_raises') IS NULL,
  'a raising board records a NULL count rather than 0 — an unmeasured board must
   not be published as a measured zero');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.public_board_liveness_state WHERE view_name='board_paused'),
  'an inactive board is not written at all');

-- ── An error must never be counted TWICE ──────────────────────────────────
-- The ELSIF/ELSE structure is what keeps a failed probe out of the min_rows and
-- max_ms comparisons. Collapsing it lets a raising board be counted as BOTH
-- empty and slow, inflating the trust arm the operator reads.
--
-- ⚠ THE FIXTURE IS THE WHOLE ASSERTION HERE. A raising board under a normal
-- max_ms fails the slow test anyway (it errors in ~0ms), so the collapsed and
-- correct versions produce identical numbers and the mutation SURVIVES —
-- verified. The only state that distinguishes them is a board that errors AND
-- would breach max_ms, so max_ms is driven to -1 for exactly that board.
UPDATE public.public_board_liveness_watchlist SET max_ms = -1 WHERE view_name='board_raises';
SELECT _assert_eq((public.public_board_liveness_sweep() ->> 'slow'), '0',
  'a board that ERRORS is never also counted slow, however long it took —
   its elapsed_ms measures a failure, not a render');
SELECT _assert_eq((public.public_board_liveness_sweep() ->> 'empty_or_error'), '3',
  'and it is still counted once, as empty');
SELECT _assert_eq(
  ((public.public_board_liveness_sweep() ->> 'empty_or_error')::int
   + (public.public_board_liveness_sweep() ->> 'slow')::int)::text,
  '3', 'a failed probe is classified exactly once');
UPDATE public.public_board_liveness_watchlist SET max_ms = 60000 WHERE view_name='board_raises';

-- ── min_rows is a THRESHOLD, not a non-zero test ──────────────────────────
UPDATE public.public_board_liveness_watchlist SET min_rows = 11 WHERE view_name='board_healthy';
SELECT _assert_eq((public.public_board_liveness_sweep() ->> 'empty_or_error'), '4',
  'a board below its min_rows is EMPTY even though it returned rows');
UPDATE public.public_board_liveness_watchlist SET min_rows = 10 WHERE view_name='board_healthy';
SELECT _assert_eq((public.public_board_liveness_sweep() ->> 'empty_or_error'), '3',
  'and exactly AT min_rows it is healthy — the comparison is strictly less-than');

-- ── max_ms marks a board SLOW without marking it empty ────────────────────
UPDATE public.public_board_liveness_watchlist SET max_ms = -1 WHERE view_name='board_healthy';
SELECT _assert_eq((public.public_board_liveness_sweep() ->> 'slow'), '1',
  'a board over its max_ms is SLOW');
SELECT _assert_eq((public.public_board_liveness_sweep() ->> 'empty_or_error'), '3',
  'and being slow does not also make it empty — they are independent signals');
UPDATE public.public_board_liveness_watchlist SET max_ms = 60000 WHERE view_name='board_healthy';

-- ── The budget stops the sweep and SAYS SO ────────────────────────────────
-- A truncated sweep that reported a clean `probed` count would read as "all
-- boards checked, all fine" — the false-green this instrument exists to avoid.
SELECT _assert_eq((public.public_board_liveness_sweep(-1) ->> 'budget_exhausted'), 'true',
  'an exhausted budget is reported rather than hidden');
SELECT _assert_eq((public.public_board_liveness_sweep(-1) ->> 'probed'), '0',
  'and the probed count reflects what was actually checked, not the watchlist size');
SELECT _assert_eq((public.public_board_liveness_sweep(-1) ->> 'active'), '4',
  'while active still reports how many SHOULD have been checked');

-- ── PREDICTIVE SKIP: declining to START a board is still INCOMPLETE coverage ──
-- Added when this pin was re-pointed 2026-08-22. The live sweep estimates each
-- board's cost from its OWN 14-day median and declines to start one that will not
-- fit in the budget left, because a running board cannot be preempted (a per-board
-- statement_timeout is armed once at the top-level statement and is re-armed by
-- neither SET LOCAL nor COMMIT).
--
-- ⚠ THE PROPERTY WORTH PINNING IS THE LAST LINE OF THAT BRANCH, not the counter:
-- a skip also sets budget_exhausted. Without it a tick that quietly checked one
-- board of four would report probed=1 with budget_exhausted=false and read as a
-- clean sweep of a short watchlist — the same false-green the -1 case above
-- guards, arriving by a different door.
INSERT INTO public.public_board_liveness_history (view_name, elapsed_ms, checked_at)
SELECT view_name, 999999, now() - interval '1 day'
  FROM public.public_board_liveness_watchlist WHERE is_active;

-- Rotation is least-recently-probed first, so board_missing (oldest) must lead.
UPDATE public.public_board_liveness_state SET checked_at = now() - interval '3 hours' WHERE view_name = 'board_missing';
UPDATE public.public_board_liveness_state SET checked_at = now() - interval '2 hours' WHERE view_name = 'board_raises';
UPDATE public.public_board_liveness_state SET checked_at = now() - interval '1 hour'  WHERE view_name = 'board_empty';
UPDATE public.public_board_liveness_state SET checked_at = now() - interval '30 minutes' WHERE view_name = 'board_healthy';

SELECT _assert_eq((public.public_board_liveness_sweep(5000) ->> 'skipped'), '3',
  'a board whose median cost cannot fit the remaining budget is SKIPPED, not probed');
SELECT _assert_eq((public.public_board_liveness_sweep(5000) ->> 'probed'), '1',
  'the FIRST board is exempt from the skip, so the sweep always makes forward progress
   rather than starving a watchlist whose every board looks too expensive');
SELECT _assert_eq((public.public_board_liveness_sweep(5000) ->> 'budget_exhausted'), 'true',
  'a SKIP marks the tick inconclusive — partial coverage must never read as a clean sweep');
SELECT _assert_eq((public.public_board_liveness_sweep(5000) ->> 'active'), '4',
  'and active still reports how many SHOULD have been checked');

-- Rotation itself, and it needs its own ISOLATED tick. Each sweep above probes the
-- least-recently-checked board and stamps it now(), so the four assertion calls
-- rotate through all four boards — which is the feature working, but it destroys
-- the ordering this check depends on. Re-seed, take exactly ONE tick, then compare.
UPDATE public.public_board_liveness_state SET checked_at = now() - interval '3 hours' WHERE view_name = 'board_missing';
UPDATE public.public_board_liveness_state SET checked_at = now() - interval '2 hours' WHERE view_name = 'board_raises';
UPDATE public.public_board_liveness_state SET checked_at = now() - interval '1 hour'  WHERE view_name = 'board_empty';
UPDATE public.public_board_liveness_state SET checked_at = now() - interval '30 minutes' WHERE view_name = 'board_healthy';
SELECT public.public_board_liveness_sweep(5000);
SELECT _assert(
  (SELECT checked_at FROM public.public_board_liveness_state WHERE view_name = 'board_missing')
  > (SELECT checked_at FROM public.public_board_liveness_state WHERE view_name = 'board_empty'),
  'rotation probes the least-recently-checked board first, so a starved board cannot
   stay starved across ticks');

SELECT '✓ public_board_liveness_sweep invariants pass' AS result;
ROLLBACK;
