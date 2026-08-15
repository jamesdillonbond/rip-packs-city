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
-- (supabase/migrations/20260810233442_audit_20260810_board_liveness_honest_sweep_decoupled.sql),
-- whose body was verified byte-identical to live prod via prosrc md5 on
-- 2026-08-15. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
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
  n_probed  integer := 0;
  n_empty   integer := 0;
  n_slow    integer := 0;
  n_active  integer;
  v_bust    boolean := false;
BEGIN
  SELECT count(*) INTO n_active FROM public.public_board_liveness_watchlist WHERE is_active;

  FOR r IN
    SELECT view_name, min_rows, max_ms
      FROM public.public_board_liveness_watchlist
     WHERE is_active
     ORDER BY view_name
  LOOP
    -- Soft deadline, checked BETWEEN boards only. It cannot preempt a single long board;
    -- one pathological view can overrun it (94.5s observed). That is accepted: the overrun
    -- is recorded as that board's honest elapsed_ms, which is the measurement we want.
    IF EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000 > p_budget_ms THEN
      v_bust := true;
      EXIT;
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

SELECT '✓ public_board_liveness_sweep invariants pass' AS result;
ROLLBACK;
