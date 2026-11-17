-- DB invariant: public.enqueue_pack_mint_tail_probes — the FORWARD TAIL that keeps
-- `pack_nft_mints` current from the chain, so a brand-new Top Shot drop is named
-- without Dapper's pack index and without a known-time neighbour. Added 2026-11-07
-- (Trevor's 15 fresh packs read "distribution not recorded" for a day: Studio's
-- index was frozen (#218) and the bracket resolver had no neighbours for a new
-- drop — `pack_nft_mints` stopped 10-29). Claims:
--
--   1. From the cursor, one probe every 3 minutes (the lane's contiguous spacing)
--      up to now() − 5 min, at most p_max per run, priority 3.
--   2. The cursor advances past every instant OFFERED, so a second run continues
--      where the first stopped and never re-offers an instant.
--   3. An instant already probed (same collection, same probe_at) is left alone —
--      the cursor still advances past it (a conflict is coverage, not a gap).
--   4. A cursor at or past the horizon enqueues nothing and does not move.
--   5. The run logs to pipeline_runs as `pack-mint-tail` with the count.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261107211500_audit_20261107_pack_mint_tail_follows_the_chain_and_fresh_not_found_rechecks.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, rows_written int, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_rows_written, p_extra) RETURNING 1::bigint $$;

CREATE TABLE public.pack_mint_probes (
  collection_id uuid NOT NULL, probe_at timestamptz NOT NULL, priority int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  start_height bigint, request_id bigint, attempts int NOT NULL DEFAULT 0, dispatched_at timestamptz,
  finished_at timestamptz, n_minted int, n_at_instant int, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, probe_at));

CREATE TABLE IF NOT EXISTS public.pack_mint_tail_state (
  collection_id uuid PRIMARY KEY,
  next_probe_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- >>> BEGIN verbatim enqueue_pack_mint_tail_probes (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.enqueue_pack_mint_tail_probes(p_max integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_max int := greatest(0, least(coalesce(p_max, 60), 600));
  v_step constant interval := interval '3 minutes';
  -- the chain is read a few minutes behind the head so a window never asks for blocks not yet sealed
  v_horizon timestamptz := now() - interval '5 minutes';
  v_total int := 0;
  v_detail jsonb := '[]'::jsonb;
  r record;
  v_last timestamptz;
  v_n int;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('enqueue_pack_mint_tail_probes')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  FOR r IN SELECT collection_id, next_probe_at FROM public.pack_mint_tail_state ORDER BY collection_id LOOP
    IF v_max = 0 OR r.next_probe_at > v_horizon THEN
      v_detail := v_detail || jsonb_build_object('collection_id', r.collection_id, 'enqueued', 0, 'next_probe_at', r.next_probe_at);
      CONTINUE;
    END IF;

    WITH inst AS (
      SELECT g AS probe_at
      FROM generate_series(r.next_probe_at, v_horizon, v_step) g
      ORDER BY g
      LIMIT v_max
    ), ins AS (
      INSERT INTO public.pack_mint_probes (collection_id, probe_at, priority)
      SELECT r.collection_id, probe_at, 3 FROM inst
      ON CONFLICT (collection_id, probe_at) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins), (SELECT max(probe_at) FROM inst) INTO v_n, v_last;

    -- The cursor advances past every instant OFFERED (a conflict means that instant is already
    -- covered by an earlier probe), never past one it has not offered.
    UPDATE public.pack_mint_tail_state
       SET next_probe_at = v_last + v_step, updated_at = now()
     WHERE collection_id = r.collection_id;

    v_total := v_total + v_n;
    v_detail := v_detail || jsonb_build_object('collection_id', r.collection_id, 'enqueued', v_n,
                                              'offered_through', v_last, 'next_probe_at', v_last + v_step);
  END LOOP;

  PERFORM public.log_pipeline_run('pack-mint-tail', v_started, v_total, v_total, 0, true, NULL,
                                  NULL, NULL, NULL,
                                  jsonb_build_object('enqueued', v_total, 'horizon', v_horizon, 'collections', v_detail));
  RETURN jsonb_build_object('ok', true, 'enqueued', v_total, 'horizon', v_horizon, 'collections', v_detail);
END
$function$;
-- <<< END verbatim enqueue_pack_mint_tail_probes <<<

-- Fixture: the cursor sits 1 hour behind the horizon (now − 5 min); one instant
-- inside that hour was already probed by another resolver.
INSERT INTO public.pack_mint_tail_state (collection_id, next_probe_at)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', date_trunc('minute', now() - interval '65 minutes'));
INSERT INTO public.pack_mint_probes (collection_id, probe_at, priority, status)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', date_trunc('minute', now() - interval '65 minutes') + interval '6 minutes', 4, 'done');

DO $$
DECLARE
  v_cursor0 timestamptz := (SELECT next_probe_at FROM public.pack_mint_tail_state);
  v_res jsonb;
BEGIN
  -- claim 1 + 2: p_max = 5 offers 5 instants, 3 minutes apart, from the cursor
  v_res := public.enqueue_pack_mint_tail_probes(5);
  PERFORM _assert_eq((v_res->>'enqueued'), '4', 'claim 1: 5 offered, 1 already probed -> 4 enqueued');
  PERFORM _assert((SELECT count(*) = 4 FROM public.pack_mint_probes WHERE priority = 3 AND status = 'pending'),
                  'claim 1: the four new probes are pending at priority 3');
  PERFORM _assert((SELECT bool_and((extract(epoch FROM probe_at - v_cursor0))::int % 180 = 0)
                     FROM public.pack_mint_probes WHERE priority = 3),
                  'claim 1: every tail instant is a whole number of 3-minute steps from the cursor');
  PERFORM _assert((SELECT status = 'done' AND priority = 4 FROM public.pack_mint_probes
                    WHERE probe_at = v_cursor0 + interval '6 minutes'),
                  'claim 3: the already-probed instant is left as it was');
  PERFORM _assert_eq((SELECT next_probe_at FROM public.pack_mint_tail_state)::text, (v_cursor0 + interval '15 minutes')::text,
                     'claim 2/3: the cursor moved past all 5 offered instants, the probed one included');
  PERFORM _assert((SELECT count(*) = 1 AND bool_and(ok) AND bool_and(rows_written = 4) FROM public.pipeline_runs_stub WHERE pipeline = 'pack-mint-tail'),
                  'claim 5: one pack-mint-tail run logged with the enqueued count');

  -- claim 2: a second run continues from the new cursor, re-offering nothing
  v_res := public.enqueue_pack_mint_tail_probes(5);
  PERFORM _assert_eq((v_res->>'enqueued'), '5', 'claim 2: the next run enqueues the next 5 instants');
  PERFORM _assert((SELECT count(*) = 9 FROM public.pack_mint_probes WHERE priority = 3),
                  'claim 2: nine tail probes after two runs (no instant offered twice)');
  PERFORM _assert_eq((SELECT next_probe_at FROM public.pack_mint_tail_state)::text, (v_cursor0 + interval '30 minutes')::text,
                     'claim 2: cursor at 10 steps');

  -- claim 1: the horizon is now − 5 min; a big budget stops there
  v_res := public.enqueue_pack_mint_tail_probes(600);
  PERFORM _assert((SELECT max(probe_at) <= now() - interval '5 minutes' FROM public.pack_mint_probes WHERE priority = 3),
                  'claim 1: no probe is enqueued past the 5-minute horizon');
  PERFORM _assert((SELECT next_probe_at > now() - interval '5 minutes' FROM public.pack_mint_tail_state),
                  'claim 1: the cursor now sits past the horizon');

  -- claim 4: at the horizon nothing is enqueued and the cursor does not move
  DECLARE v_before timestamptz := (SELECT next_probe_at FROM public.pack_mint_tail_state);
  BEGIN
    v_res := public.enqueue_pack_mint_tail_probes(60);
    PERFORM _assert_eq((v_res->>'enqueued'), '0', 'claim 4: nothing to offer at the horizon');
    PERFORM _assert_eq((SELECT next_probe_at FROM public.pack_mint_tail_state)::text, v_before::text,
                       'claim 4: the cursor does not move when nothing was offered');
  END;
END $$;

ROLLBACK;
