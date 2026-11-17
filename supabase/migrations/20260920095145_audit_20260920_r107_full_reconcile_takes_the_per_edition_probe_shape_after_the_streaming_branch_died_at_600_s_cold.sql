-- ↩ Follow-up to 20260920020102 (R107: the full reconcile of edition_fmv_current became callable
-- and daily as jobid 539, `36 9 * * *`, cron_heavy). Its first scheduled tick, 2026-09-20 09:36Z
-- (2:36 AM PT), FAILED at 600 s: `canceling statement due to statement timeout` inside the full
-- branch's `WITH latest` — a DISTINCT ON over every fmv_snapshots row (~1.2 M) on a cache the
-- pack_rips autovacuum pass had just evicted (2 GB, ended 09:07Z). The 7:03 PM PT control run
-- (45 s) had run on pages the OLD confidence precompute streamed through minutes earlier; it was
-- a warm-cache number and the header called it "~27 s warm, minutes when cold" — it is 600+ s cold.
-- ⚠ And the wrapper's EXCEPTION block did NOT produce the ok=false pipeline_runs row it promises
-- (no 'edition-fmv-current-full-reconcile' row exists for 09:36Z; cron.job_run_details holds the
-- error with the CONTEXT of the inner statement). The R110-class claim of that wrapper is
-- unproven for a 57014 — filed in the ledger; not changed here.
--
-- Fix: the full branch takes R115's shape — one ordered index probe per edition via LATERAL …
-- LIMIT 1 over `editions` (complete: fmv_snapshots_edition_id_fkey), Merge Append across the
-- year partitions. Measured on the same cold box at 2:5x AM PT: 21,424 editions, 124,588 buffers
-- (12,444 physical), 74.7 s. Same selection rule (latest computed_at per edition; ties arbitrary
-- in both). The incremental branch, the prune, the return shape and the wrapper are untouched.
-- Body otherwise verbatim from the committed 20260920020102 text (live prosrc md5
-- 33ae9547bcc6955a29e49f5f7d10bb4c == committed, checked before editing).
--
-- Also this pass: the weekly `VACUUM FULL net._http_response` (jobid from 20260920020934,
-- `43 9 * * 0`) ran INSIDE this reconcile's window (09:43Z, Sunday) and took 117 s of its 120 s
-- default — 7.7 s on the quiet evening box — while holding ACCESS EXCLUSIVE; every pg_net lane sat
-- on `Lock: relation` for two minutes. Rescheduled in 20260920095221 (next file).
--
-- Applied from Cowork cloud 2026-09-20 ~2:55 AM PT. Same signature ⇒ ACL preserved.
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
--
-- EXIT: 09-21 09:36Z tick `succeeded`; pipeline_runs row ok=true, upserted ≈ 21.4k, wall_ms < 200,000.
-- FALSIFIER: a 600 s kill at 09:36Z with io_wait < 3 ⇒ the probe shape is not enough on this
--   table and the reconcile must chunk per collection; with io_wait > 10 ⇒ the slot.
-- REVERT: re-apply 20260920020102's refresh_edition_fmv_current body (the DISTINCT ON branch).
--
-- anon-exec: intentional — same signature, existing ACL preserved (REVOKEd from PUBLIC/anon/authenticated by 20260920020102); pg_cron as cron_heavy and R107 hand runs call it (refresh_edition_fmv_current)

CREATE OR REPLACE FUNCTION public.refresh_edition_fmv_current(p_full boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_stamp     timestamptz := now();
  v_watermark timestamptz;
  v_cutoff    timestamptz;
  v_rows      int;
  v_pruned    int := 0;
  v_full      boolean;
BEGIN
  SELECT max(computed_at) INTO v_watermark FROM edition_fmv_current;
  -- 2026-09-19 (R107): callable on demand. Until today this was `v_watermark IS NULL`, i.e. only
  -- an EMPTY table could ever take the full branch, so the reconcile the column comment asks for
  -- did not exist as a schedulable thing.
  v_full := p_full OR v_watermark IS NULL;

  IF v_full THEN
    -- Cold start, or the daily reconcile. 2026-09-20: the first cron tick of this branch (09:36Z)
    -- DIED at cron_heavy's 600 s streaming every snapshot through DISTINCT ON on a cold cache
    -- (the 45 s control the evening before ran on pages the old precompute had just warmed).
    -- Same rule, R115's shape: one ordered index probe per edition (every snapshot's edition is
    -- in `editions` — fmv_snapshots_edition_id_fkey), Merge Append across the year partitions,
    -- LIMIT 1. Measured on the same cold box minutes after the kill: 21,424 editions,
    -- 124,588 buffers (12,444 read), 74.7 s; the streaming shape had not finished at 600 s.
    WITH latest AS MATERIALIZED (
      SELECT e.id AS edition_id, s.collection_id, s.fmv_usd, s.floor_price_usd, s.confidence, s.computed_at
      FROM editions e
      CROSS JOIN LATERAL (
        SELECT fs.collection_id, fs.fmv_usd, fs.floor_price_usd, fs.confidence, fs.computed_at
        FROM fmv_snapshots fs
        WHERE fs.edition_id = e.id
        ORDER BY fs.computed_at DESC
        LIMIT 1
      ) s
    )
    INSERT INTO edition_fmv_current AS t
      (edition_id, collection_id, fmv_usd, floor_price_usd, confidence, computed_at, refreshed_at)
    SELECT l.edition_id, l.collection_id, l.fmv_usd, l.floor_price_usd, l.confidence, l.computed_at, v_stamp
    FROM latest l
    ON CONFLICT (edition_id) DO UPDATE SET
      collection_id = EXCLUDED.collection_id, fmv_usd = EXCLUDED.fmv_usd,
      floor_price_usd = EXCLUDED.floor_price_usd, confidence = EXCLUDED.confidence,
      computed_at = EXCLUDED.computed_at, refreshed_at = EXCLUDED.refreshed_at;

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    -- Prune = cache rows whose edition no longer has ANY snapshot (every edition with one was
    -- just stamped v_stamp above). Measured 0 such rows on 2026-09-19.
    DELETE FROM edition_fmv_current WHERE refreshed_at < v_stamp;
    GET DIAGNOSTICS v_pruned = ROW_COUNT;
  ELSE
    v_cutoff := v_watermark - interval '2 hours';

    WITH latest AS MATERIALIZED (
      SELECT DISTINCT ON (s.edition_id)
             s.edition_id, s.collection_id, s.fmv_usd, s.floor_price_usd, s.confidence, s.computed_at
      FROM fmv_snapshots s
      WHERE s.computed_at > v_cutoff
      ORDER BY s.edition_id, s.computed_at DESC
    )
    INSERT INTO edition_fmv_current AS t
      (edition_id, collection_id, fmv_usd, floor_price_usd, confidence, computed_at, refreshed_at)
    SELECT l.edition_id, l.collection_id, l.fmv_usd, l.floor_price_usd, l.confidence, l.computed_at, v_stamp
    FROM latest l
    ON CONFLICT (edition_id) DO UPDATE SET
      collection_id = EXCLUDED.collection_id, fmv_usd = EXCLUDED.fmv_usd,
      floor_price_usd = EXCLUDED.floor_price_usd, confidence = EXCLUDED.confidence,
      computed_at = EXCLUDED.computed_at, refreshed_at = EXCLUDED.refreshed_at
    -- Never move a row backwards: a late-arriving OLDER snapshot must not
    -- overwrite a newer one just because it was written after it.
    WHERE EXCLUDED.computed_at >= t.computed_at;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'full_rebuild', v_full,
    'watermark', v_watermark,
    'cutoff', v_cutoff,
    'upserted', v_rows,
    'pruned', v_pruned,
    'duration_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int
  );
END;
$function$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.refresh_edition_fmv_current(boolean)'::regprocedure;
  IF strpos(v_src, 'CROSS JOIN LATERAL') = 0 THEN RAISE EXCEPTION 'probe shape missing'; END IF;
  IF strpos(v_src, 'FROM fmv_snapshots s
      ORDER BY s.edition_id, s.computed_at DESC') > 0 THEN RAISE EXCEPTION 'streaming full branch still present'; END IF;
  IF has_function_privilege('anon', 'public.refresh_edition_fmv_current(boolean)', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked'; END IF;
END $$;
