-- audit_20260810: give the board-liveness sweep a PERSISTENCE store, without touching it.
--
-- WHY. `public_board_liveness_state` upserts ONE row per board and keeps no history — verified
-- live: 45 rows / 45 distinct view_name / exactly ONE distinct checked_at. Each sweep overwrites
-- the last. That matters because a single honest timing on this instance is NOT trustworthy:
-- measured 20 minutes apart, candy_pack_ev_model went 94,508 ms -> under budget and
-- panini_squeeze_board >60,000 ms -> 4,284 ms. Cache residency dominates, so the only trustworthy
-- triage signal is "breaches PERSISTENTLY across sweeps" — and there was nowhere to read that from.
--
-- SHAPE. Deliberately DECOUPLED: a separate table + its own pg_cron job that snapshots the state
-- table after each sweep. ZERO edits to public_board_liveness_sweep() / _probe() /
-- rpc_thp_leg_board_liveness(), which were shipped ~1h before this and are owned by another
-- session. Nothing here can regress them.
--
-- Capture is keyed on (view_name, checked_at) with ON CONFLICT DO NOTHING, so it is idempotent and
-- a failed/skipped sweep simply appends nothing — absence of history is then honest evidence the
-- sweep did not run, rather than a silently repeated row.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-capture-board-liveness-history');
--   DROP FUNCTION public.capture_board_liveness_history();
--   DROP TABLE public.public_board_liveness_history;
DO $mig$
BEGIN
  IF to_regclass('public.public_board_liveness_state') IS NULL THEN
    RAISE EXCEPTION 'public_board_liveness_state is absent -- refusing to build history for a table that does not exist';
  END IF;
END
$mig$;

CREATE TABLE IF NOT EXISTS public.public_board_liveness_history
  (LIKE public.public_board_liveness_state INCLUDING DEFAULTS);

ALTER TABLE public.public_board_liveness_history
  ADD COLUMN IF NOT EXISTS captured_at timestamptz NOT NULL DEFAULT now();

DO $pk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.public_board_liveness_history'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE public.public_board_liveness_history
      ADD CONSTRAINT public_board_liveness_history_pkey PRIMARY KEY (view_name, checked_at);
  END IF;
END
$pk$;

CREATE INDEX IF NOT EXISTS idx_board_liveness_history_checked_at
  ON public.public_board_liveness_history (checked_at DESC);

-- ops data: RLS on, no anon/authenticated reach (new-public-table rule)
ALTER TABLE public.public_board_liveness_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.public_board_liveness_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.public_board_liveness_history TO postgres, service_role;

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

REVOKE ALL ON FUNCTION public.capture_board_liveness_history() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_board_liveness_history() TO postgres, service_role;

-- sweep is `28 */6` and takes ~202s (done by ~:32); capture at :51 leaves ~20 min of margin.
-- :51 is a free minute (no fixed job; the */2 job occupies even minutes only).
DO $sched$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-capture-board-liveness-history') THEN
    PERFORM cron.schedule('rpc-capture-board-liveness-history', '51 */6 * * *',
                          'SELECT public.capture_board_liveness_history()');
  END IF;
END
$sched$;
