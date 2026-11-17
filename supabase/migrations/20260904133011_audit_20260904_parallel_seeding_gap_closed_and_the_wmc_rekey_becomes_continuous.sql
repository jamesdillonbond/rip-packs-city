-- audit_20260904_parallel_seeding_gap_closed_and_the_wmc_rekey_becomes_continuous
-- Applied to prod via MCP apply_migration 2026-09-04 13:30Z (version 20260904133011).
-- ⚠ Superseded in part by 20260904133105 the same hour — that migration adds the `p_queue_cap`
--   third argument and DROPs this file's 2-arg overload. Apply both, in order.
-- First measured tick: 60 bases scanned, 3,919 Moments seeded (the pending queue was 0 before it).
-- REVERT: SELECT cron.unschedule('rpc-topshot-parallel-seed'); SELECT cron.unschedule('rpc-wmc-parallel-rekey');
--   DROP FUNCTION public.seed_topshot_parallel_base_targets(integer,integer,integer);
--   DROP TABLE public.topshot_parallel_seed_state;
--   rekey_topshot_wmc_parallels: the one-shot body in 20260904062632 (only the cursor-wrap and the
--   run-row condition differ). Seeded PENDING rows are inert — the resolver simply has less to do.

-- The parallel resolution pipeline had a SEEDING gap: `topshot_moment_subeditions` is only ever
-- seeded from (a) conflated editions, (b) ::N-keyed mis-keys, (c) Moments in the newest TWO series,
-- (d) collision-knot occupants. A parallel Moment in an OLDER parallel-bearing set that never
-- collided is never queued, so it is never resolved on-chain, so it stays keyed (and priced) as the
-- Standard printing forever. Measured 2026-09-04 against Dapper's Atlas API on the founder's wallet:
-- after the 67,530-row rekey, 352 of his 15,183 Moments were still base-keyed while Atlas reports
-- them as Hexwave / Bit / Rippled — and the three sampled nfts are ABSENT from the map entirely
-- (not mis-resolved: never seeded). Series 5-6 parallels (`102:3512` Bit, `90:3563` Rippled) are
-- outside the "newest two series" window by construction.
--
-- This adds the missing arm — every Moment of a base edition that HAS cataloged parallels, whatever
-- its series — and makes the rekey continuous instead of one-shot, so a newly-resolved parallel is
-- re-keyed on the next cycle rather than waiting for a human.

CREATE TABLE IF NOT EXISTS public.topshot_parallel_seed_state (
  id          integer PRIMARY KEY,
  cursor_base text NOT NULL DEFAULT '',
  cycles      integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.topshot_parallel_seed_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.topshot_parallel_seed_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.topshot_parallel_seed_state TO postgres, service_role, cron_heavy;

-- Seeds PENDING rows (subedition_id NULL) for holders' Moments of parallel-bearing base editions.
-- The existing drain-conflated-subeditions step 2 (the backfill-topshot-subeditions edge fn) is what
-- resolves them on-chain — this only fills the queue it reads. Cursor over the ~1,993 parallel-
-- bearing bases; wraps to the start when it reaches the end, so newly-acquired Moments are caught.
-- anon-exec: no — seed_topshot_parallel_base_targets is a writer; REVOKE … FROM PUBLIC, anon,
--   authenticated below; postgres/service_role/cron_heavy only.
CREATE OR REPLACE FUNCTION public.seed_topshot_parallel_base_targets(p_bases integer DEFAULT 60, p_max_rows integer DEFAULT 4000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_cursor text;
  v_next   text;
  v_bases  integer := 0;
  v_seeded integer := 0;
BEGIN
  INSERT INTO public.topshot_parallel_seed_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT cursor_base INTO v_cursor FROM public.topshot_parallel_seed_state WHERE id = 1;

  DROP TABLE IF EXISTS _par_bases;
  CREATE TEMP TABLE _par_bases ON COMMIT DROP AS
    SELECT DISTINCT split_part(e.external_id, '::', 1) AS base
      FROM public.editions e
     WHERE e.collection_id = v_ts
       AND e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
       AND split_part(e.external_id, '::', 1) > v_cursor
     ORDER BY 1
     LIMIT GREATEST(p_bases, 1);
  SELECT count(*), max(base) INTO v_bases, v_next FROM _par_bases;

  IF v_bases > 0 THEN
    INSERT INTO public.topshot_moment_subeditions (nft_id, base_external_id, subedition_id)
    SELECT cur.nft_id, cur.base, NULL::smallint
    FROM (
      SELECT DISTINCT w.moment_id AS nft_id, b.base
        FROM _par_bases b
        JOIN public.wallet_moments_cache w
          ON w.collection_id = v_ts AND w.edition_key = b.base
       WHERE w.moment_id ~ '^[0-9]+$'
      UNION
      SELECT DISTINCT s.nft_id, b.base
        FROM _par_bases b
        JOIN public.editions e ON e.collection_id = v_ts AND e.external_id = b.base
        JOIN public.sales s ON s.collection_id = v_ts AND s.edition_id = e.id
       WHERE s.nft_id ~ '^[0-9]+$'
    ) cur
    WHERE NOT EXISTS (SELECT 1 FROM public.topshot_moment_subeditions t WHERE t.nft_id = cur.nft_id)
    LIMIT GREATEST(p_max_rows, 1)
    ON CONFLICT (nft_id) DO NOTHING;
    GET DIAGNOSTICS v_seeded = ROW_COUNT;
  END IF;

  -- Wrap at the end of the base list rather than stopping: a Moment acquired tomorrow in an old
  -- parallel set needs the same arm, and an empty pass is ~ms.
  UPDATE public.topshot_parallel_seed_state
     SET cursor_base = CASE WHEN v_bases > 0 THEN v_next ELSE '' END,
         cycles      = cycles + CASE WHEN v_bases > 0 THEN 0 ELSE 1 END,
         updated_at  = now()
   WHERE id = 1;

  RETURN jsonb_build_object('bases', v_bases, 'seeded', v_seeded, 'cursor', v_next);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.seed_topshot_parallel_base_targets(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_topshot_parallel_base_targets(integer, integer) TO postgres, service_role, cron_heavy;

-- The rekey becomes continuous: at the end of the walk it resets its cursor instead of unscheduling,
-- so a Moment the edge fn resolves TODAY is re-keyed on the next cycle. An exhausted pass is 122 ms
-- measured; a full cycle is ~15 ticks.
-- anon-exec: no — rekey_topshot_wmc_parallels is a writer and was already revoked in 20260904062632;
--   the REVOKE/GRANT is re-stated below because CREATE OR REPLACE does not reset an acl but a fresh
--   database applying this file in order must land in the same place.
CREATE OR REPLACE FUNCTION public.rekey_topshot_wmc_parallels(p_scan integer DEFAULT 20000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_cursor text;
  v_next   text;
  v_scanned integer := 0;
  v_n integer := 0;
  v_ok boolean := true;
  v_err text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('rekey_topshot_wmc_parallels')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  INSERT INTO public.wmc_parallel_rekey_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT cursor_nft INTO v_cursor FROM public.wmc_parallel_rekey_state WHERE id = 1;
  BEGIN
    DROP TABLE IF EXISTS _rk_scan;
    CREATE TEMP TABLE _rk_scan ON COMMIT DROP AS
      SELECT sub.nft_id, sub.base_external_id, sub.subedition_id
        FROM public.topshot_moment_subeditions sub
       WHERE sub.nft_id > v_cursor
         AND coalesce(sub.subedition_id, 0) > 0        -- Standard rows have nothing to rekey
       ORDER BY sub.nft_id
       LIMIT GREATEST(p_scan, 1);
    SELECT count(*), max(nft_id) INTO v_scanned, v_next FROM _rk_scan;

    WITH cand AS (
      SELECT w.id, w.edition_key AS old_key, w.fmv_usd AS old_fmv, w.fmv_confidence AS old_conf,
             se.external_id AS new_key, l.fmv_usd AS new_fmv, l.confidence AS new_conf
        FROM _rk_scan sub
        JOIN public.wallet_moments_cache w
          ON w.moment_id = sub.nft_id
         AND w.collection_id = v_ts
         AND w.edition_key = sub.base_external_id
        JOIN public.editions se
          ON se.collection_id = v_ts
         AND se.external_id = sub.base_external_id || '::' || sub.subedition_id::text
        LEFT JOIN public.edition_fmv_current l ON l.edition_id = se.id
       WHERE coalesce(sub.subedition_id, 0) > 0
    ),
    logged AS (
      INSERT INTO public.audit_20260904_wmc_parallel_rekey (wmc_id, old_key, new_key, old_fmv, old_conf)
      SELECT id, old_key, new_key, old_fmv, old_conf FROM cand
      ON CONFLICT (wmc_id) DO NOTHING
    ),
    upd AS (
      UPDATE public.wallet_moments_cache w
         SET edition_key    = c.new_key,
             fmv_usd        = c.new_fmv,
             fmv_confidence = c.new_conf
        FROM cand c
       WHERE w.id = c.id
      RETURNING 1
    )
    SELECT count(*)::int INTO v_n FROM upd;

    -- Continuous: wrap to the start when the walk is exhausted.
    UPDATE public.wmc_parallel_rekey_state
       SET cursor_nft = CASE WHEN v_scanned > 0 THEN COALESCE(v_next, cursor_nft) ELSE '' END,
           updated_at = now()
     WHERE id = 1;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  -- Only a tick that did something writes a run row (an exhausted pass is a no-op, twice an hour).
  IF v_scanned > 0 OR NOT v_ok THEN
    PERFORM public.log_pipeline_run('wmc-parallel-rekey', v_started, v_scanned, v_n, 0, v_ok, v_err, 'nba_top_shot', v_cursor, v_next,
              jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int, 'scan', p_scan, 'via', 'pg_cron'));
  END IF;
  RETURN jsonb_build_object('scanned', v_scanned, 'rekeyed', v_n, 'cursor', v_next, 'ok', v_ok, 'error', v_err);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.rekey_topshot_wmc_parallels(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rekey_topshot_wmc_parallels(integer) TO postgres, service_role, cron_heavy;

-- :31/:57 and :38/:49 — the only minute fields on this database carrying NO other pg_cron job
-- (enumerated 2026-09-04); the board is dense, so this was picked by measurement, not by habit.
SELECT cron.schedule('rpc-topshot-parallel-seed', '31,57 * * * *', $$SELECT public.seed_topshot_parallel_base_targets(60, 4000)$$);
SELECT cron.schedule('rpc-wmc-parallel-rekey',    '38,49 * * * *', $$SELECT public.rekey_topshot_wmc_parallels(20000)$$);
