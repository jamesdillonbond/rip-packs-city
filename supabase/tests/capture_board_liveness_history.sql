-- DB invariant: public.capture_board_liveness_history — snapshots the live board-liveness
-- STATE table into a 90-day HISTORY table, on pg_cron `rpc-capture-board-liveness-history`
-- (`51 */6 * * *`).
--
-- It was unpinned until 2026-08-16 for the same reason as the Pinnacle FMV writer: it is
-- NOT SECURITY DEFINER, so a SECDEF-scoped sweep of scheduled writers could not see it.
--
-- Why it matters beyond tidiness: `public_board_slow_count` is one of the five currently
-- breached arms, and this table is the ONLY record of how it got there. CLAUDE.md records
-- that arm being characterised as "oscillating down" and then as "climbing, not
-- oscillating" within a day, both readings fair on ~1 day of data — the conclusion being
-- that its direction cannot be read from a short window. This function is what makes the
-- long window exist at all, so over-pruning here does not produce an error, it produces
-- an ABSENCE that reads as "we have no history" rather than "we deleted it".
--
-- The DDL below is VERBATIM from its committed migration, verified against live prod
-- prosrc (whitespace-collapsed md5) on 2026-08-16.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.public_board_liveness_state (
  view_name  text,
  row_count  int,
  elapsed_ms int
);
CREATE TABLE public.public_board_liveness_history (
  view_name  text,
  row_count  int,
  elapsed_ms int,
  checked_at timestamptz,
  PRIMARY KEY (view_name, checked_at)
);

-- >>> BEGIN verbatim capture_board_liveness_history (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.capture_board_liveness_history()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_inserted integer;
  v_pruned   integer;
BEGIN
  INSERT INTO public.public_board_liveness_history AS h
  SELECT s.*, now()
    FROM public.public_board_liveness_state s
  ON CONFLICT (view_name, checked_at) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  DELETE FROM public.public_board_liveness_history
   WHERE checked_at < now() - interval '90 days';
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  RETURN jsonb_build_object('inserted', v_inserted, 'pruned', v_pruned, 'at', now());
END
$fn$;
-- <<< END verbatim capture_board_liveness_history <<<

INSERT INTO public.public_board_liveness_state VALUES
  ('candy_pack_market', 1, 128000),
  ('topshot_deals',    50,   9000);

-- Rows straddling the 90-day retention boundary, planted directly.
INSERT INTO public.public_board_liveness_history VALUES
  ('old_board', 1, 1, now() - interval '91 days'),   -- outside retention
  ('edge_board',1, 1, now() - interval '90 days'),   -- EXACTLY at the boundary
  ('new_board', 1, 1, now() - interval '89 days');   -- inside retention

SELECT public.capture_board_liveness_history();

-- ── The capture takes a row per board, stamped at capture time ──────────────
SELECT _assert_eq((SELECT count(*)::text FROM public.public_board_liveness_history
                    WHERE checked_at > now() - interval '1 minute'), '2',
  'one history row per board in the state table');
SELECT _assert_eq((SELECT elapsed_ms::text FROM public.public_board_liveness_history
                    WHERE view_name='candy_pack_market' AND checked_at > now() - interval '1 minute'),
  '128000', 'the measurement is copied verbatim — this table IS the trend data, so a '
  'rounded or bucketed copy would destroy the thing it exists to preserve');

-- ── The 90-day prune boundary, in both directions ──────────────────────────
-- `< now() - interval '90 days'` is strict, so the row EXACTLY at 90 days survives.
SELECT _assert_eq((SELECT count(*)::text FROM public.public_board_liveness_history
                    WHERE view_name='old_board'), '0',
  'a row older than 90 days is pruned');
SELECT _assert_eq((SELECT count(*)::text FROM public.public_board_liveness_history
                    WHERE view_name IN ('edge_board','new_board')), '2',
  'the boundary is strict: a row EXACTLY at 90 days is KEPT, along with everything newer. '
  'Over-pruning here is invisible — it leaves no error, only a shorter history, and a '
  'shorter history reads as "we never measured that" rather than "we deleted it"');

-- ── Re-running within the same transaction is a no-op, not a duplicate ─────
-- `now()` is transaction-stable, so a second call collides on (view_name, checked_at)
-- and DO NOTHING absorbs it. In production the two calls are 6h apart and both land.
SELECT public.capture_board_liveness_history();
SELECT _assert_eq((SELECT count(*)::text FROM public.public_board_liveness_history
                    WHERE checked_at > now() - interval '1 minute'), '2',
  'a same-transaction re-run adds nothing — ON CONFLICT DO NOTHING plus a transaction-stable '
  'now() makes the capture idempotent per transaction');
SELECT _assert_eq((public.capture_board_liveness_history() ->> 'inserted'), '0',
  'and it REPORTS the zero rather than claiming two inserts — the return value is what a '
  'caller would log, so an honest 0 is what makes a stalled capture visible');

SELECT '✓ capture_board_liveness_history invariants pass' AS result;

ROLLBACK;
