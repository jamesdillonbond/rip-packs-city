-- R115, the STRUCTURAL half (register 2026-09-19). `20260920001632` gave jobid 506
-- (`rpc-refresh-fmv-confidence-precompute`, `35 1,5,9,13` UTC) a 300 s budget and said in its
-- own header: "⛔ This is a ceiling raise, not the structural fix … Top Shot is recomputed from
-- all history every 4 h" — `sentinel_fmv_confidence_rows(cid)` streams every fmv_snapshots row
-- of the collection (1,095,052 for 14,016 Top Shot editions, 78:1) through a DISTINCT ON to
-- find the newest one per edition, and that ratio grows with every FMV write. The same header
-- recorded WHY the obvious source was off limits: "Reading `edition_fmv_current` instead is
-- forbidden in writing by that table's own column comment (R107)."
--
-- R107 closed tonight (`20260920020102`): `edition_fmv_current` IS the newest-snapshot-per-
-- edition table, refreshed hourly (incremental, jobid 357) and fully reconciled daily (jobid
-- 539, 2:36 AM PT), and its comment now states the gate for a new reader — the drift guard at
-- zero and a fresh full-reconcile row. Both hold as of this migration (drift [] at 7:5x PM PT;
-- full reconcile 7:03 PM PT). ⭐ EQUIVALENCE PROVED OVER THE POPULATION, not assumed: at
-- 7:5x PM PT the cache disagreed with the live DISTINCT ON on 2,068 editions — and EVERY one of
-- them had its newest snapshot stamped AFTER the cache's last refresh (7:08–7:36 PM PT);
-- `behind_but_older_than_watermark = 0`, `missing_from_cache = 0`. The cache is the live answer
-- minus at most one hourly refresh of lag, and this precompute is read 6-hourly by
-- `rpc_ops_snapshot()` (its only consumer), so a ≤ 1 h-old distribution is FRESHER than the
-- previous tick's, not staler.
--
-- What changes: the fmv_snapshots arm reads `edition_fmv_current` grouped by confidence (a
-- 21k-row scan; Top Shot 5.3 s → milliseconds quiet, and no longer a 100 s IO stream inside a
-- spell — the shape that killed the 09-19 02:35 and 06:35 PT runs at 120 s). The Pinnacle arm
-- is unchanged. Provenance travels with the row: two new columns, `source` (which table) and
-- `source_newest_computed_at` (the newest cached snapshot for that collection — the lag is
-- readable, not inferred), and the run's `pipeline_runs` extra carries `efc_drift_rows` from
-- `check_edition_fmv_current_source_drift(1)` so a distribution computed off a drifting cache
-- says so in the record. `sentinel_fmv_confidence_rows(uuid)` is kept as-is (a pinned function
-- with a migration history); it simply has no scheduled caller now.
--
-- Same signature ⇒ ACL preserved (anon/authenticated EXECUTE false, service_role true — asserted).
-- Applied from Cowork cloud 2026-09-19 7:44 PM PT. In-migration control: nba_top_shot 5,286 ms → 31 ms, Candy 62.4 %, Pinnacle 28.0 %, Top Shot HIGH+MEDIUM 52.7 %, efc_drift_rows 0. ⚠ That session's push tooling is its own
-- concern; this file commits as usual.
--
-- EXIT: the 10:35 PM PT tick (jobid 506) succeeds with `nba_top_shot.duration_ms` < 2,000 and
-- `source = 'edition_fmv_current'` on the five snapshot-backed rows; Candy HIGH+MEDIUM and
-- Pinnacle stay within a couple of points of the previous run (62.4 % / 28.0 %).
-- FALSIFIER: `efc_drift_rows > 0` on a run ⇒ the cache is drifting between reconciles and the
-- distribution inherits it — read R107's falsifier before trusting the counts.
-- REVERT: re-apply the function body from 20260920001632 (identical except the snapshot arm
--         reads sentinel_fmv_confidence_rows(r.cid)); the two columns may stay (nullable).
--
-- anon-exec: intentional — same signature, existing ACL preserved, only pg_cron/service_role call it (refresh_fmv_confidence_precompute)
-- (anon/authenticated EXECUTE false and service_role true are asserted in the DO block below)

ALTER TABLE public.fmv_confidence_precompute
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS source_newest_computed_at timestamptz;

COMMENT ON COLUMN public.fmv_confidence_precompute.source IS
  'Which table the counts were read from: edition_fmv_current (newest snapshot per edition, ≤ 1 h of incremental lag, daily full reconcile) or pinnacle_fmv_history. Added 2026-09-19 (R115 structural).';
COMMENT ON COLUMN public.fmv_confidence_precompute.source_newest_computed_at IS
  'max(computed_at) of the source rows this distribution was read from — the lag between this and computed_at is the cache''s, readable rather than inferred.';

CREATE OR REPLACE FUNCTION public.refresh_fmv_confidence_precompute()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r         record;
  v_counts  jsonb;
  v_note    text;
  v_src_at  timestamptz;
  v_start   timestamptz;
  v_run_at  timestamptz := clock_timestamp();
  v_ms      integer;
  v_ok      integer := 0;
  v_failed  jsonb   := '[]'::jsonb;
  v_drift   integer := NULL;
  v_pinn    constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
BEGIN
  -- ⭐ Derived, not curated (R116). Every collection that has at least one row in
  -- fmv_snapshots, plus Pinnacle from its own table. A future collection appears the
  -- moment its first snapshot lands; nothing here needs editing for it.
  FOR r IN
    SELECT c.slug, c.id AS cid, 'edition_fmv_current'::text AS src
      FROM public.collections c
     WHERE EXISTS (SELECT 1 FROM public.fmv_snapshots fs WHERE fs.collection_id = c.id)
    UNION ALL
    SELECT c.slug, c.id, 'pinnacle_fmv_history'
      FROM public.collections c
     WHERE c.id = v_pinn
       AND EXISTS (SELECT 1 FROM public.pinnacle_fmv_history)
     ORDER BY 1
  LOOP
    BEGIN
      v_start  := clock_timestamp();
      v_note   := NULL;
      v_src_at := NULL;

      IF r.src = 'pinnacle_fmv_history' THEN
        -- Pinnacle is keyed on render_id, not edition_id, and has ZERO rows in
        -- fmv_snapshots — reading it there published a permanent `{}` (R116).
        SELECT jsonb_object_agg(d.conf, d.n), max(d.newest)
          INTO v_counts, v_src_at
          FROM (
            SELECT x.conf::text AS conf, count(*)::bigint AS n, max(x.computed_at) AS newest
              FROM (
                SELECT DISTINCT ON (h.render_id) h.fmv_confidence AS conf, h.computed_at
                  FROM public.pinnacle_fmv_history h
                 ORDER BY h.render_id, h.computed_at DESC
              ) x
             GROUP BY x.conf
          ) d;
      ELSE
        -- R115 structural (2026-09-19): the newest snapshot per edition is what
        -- edition_fmv_current holds (hourly incremental + daily full reconcile, R107), so
        -- read the 21k-row cache instead of streaming every snapshot of the collection
        -- through a DISTINCT ON (Top Shot: 1.1 M rows for 14 k editions, 78:1 and growing).
        SELECT jsonb_object_agg(d.conf, d.n), max(d.newest)
          INTO v_counts, v_src_at
          FROM (
            SELECT f.confidence::text AS conf, count(*)::bigint AS n, max(f.computed_at) AS newest
              FROM public.edition_fmv_current f
             WHERE f.collection_id = r.cid
             GROUP BY f.confidence
          ) d;
      END IF;

      -- ⚠ No coalesce to '{}'. A NULL aggregate here means the source has rows (the
      -- loop proved it) but the arm's query matched none — say so rather than publish
      -- a well-formed empty object that reads as "measured: nothing".
      IF v_counts IS NULL THEN
        v_note := format('arm ran %s but matched no rows in %s', to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'), r.src);
      END IF;

      v_ms := (EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000)::integer;

      INSERT INTO public.fmv_confidence_precompute AS f
             (collection_id, slug, counts, computed_at, duration_ms, note, source, source_newest_computed_at)
      VALUES (r.cid, r.slug, v_counts, clock_timestamp(), v_ms, v_note, r.src, v_src_at)
      ON CONFLICT (collection_id) DO UPDATE
        SET slug        = EXCLUDED.slug,
            counts      = EXCLUDED.counts,
            computed_at = EXCLUDED.computed_at,
            duration_ms = EXCLUDED.duration_ms,
            note        = EXCLUDED.note,
            source      = EXCLUDED.source,
            source_newest_computed_at = EXCLUDED.source_newest_computed_at;

      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || jsonb_build_object('slug', r.slug, 'error', SQLERRM);
    END;
  END LOOP;

  -- Provenance for the record: is the cache these counts came from drifting from its
  -- source right now? (R107's ban-at-zero guard; a full check is an index join of 21k rows.)
  BEGIN
    v_drift := jsonb_array_length(public.check_edition_fmv_current_source_drift(1));
  EXCEPTION WHEN OTHERS THEN
    v_drift := NULL;  -- unmeasured, never 0
  END;

  -- R110 class: until 2026-09-19 a killed run of this lane was visible only in
  -- cron.job_run_details. One terminal row per run, ok iff no arm failed.
  BEGIN
    PERFORM public.log_pipeline_run(
      'fmv-confidence-precompute',
      jsonb_array_length(v_failed) = 0,
      jsonb_build_object('refreshed', v_ok, 'failed', v_failed,
                         'source', 'edition_fmv_current+pinnacle_fmv_history',
                         'efc_drift_rows', v_drift,
                         'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_run_at)) * 1000)::integer)
    );
  EXCEPTION WHEN OTHERS THEN
    -- The record must never be the thing that fails the refresh.
    NULL;
  END;

  RETURN jsonb_build_object('refreshed', v_ok, 'failed', v_failed, 'efc_drift_rows', v_drift, 'at', clock_timestamp());
END;
$function$;

-- Positive control, in the migration's own transaction: one run as postgres (the job's role).
SELECT public.refresh_fmv_confidence_precompute();

DO $$
DECLARE v_rows int; v_ts_ms int; v_src_ok int; v_res jsonb;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE source IN ('edition_fmv_current','pinnacle_fmv_history') AND source_newest_computed_at IS NOT NULL)
    INTO v_rows, v_src_ok FROM public.fmv_confidence_precompute;
  IF v_rows < 6 THEN RAISE EXCEPTION 'expected >= 6 precompute rows, got %', v_rows; END IF;
  IF v_src_ok <> v_rows THEN RAISE EXCEPTION 'provenance missing on % of % rows', v_rows - v_src_ok, v_rows; END IF;
  SELECT duration_ms INTO v_ts_ms FROM public.fmv_confidence_precompute WHERE slug = 'nba_top_shot';
  IF v_ts_ms IS NULL OR v_ts_ms > 5000 THEN RAISE EXCEPTION 'nba_top_shot arm took % ms — the cache read did not bind', v_ts_ms; END IF;
  IF EXISTS (SELECT 1 FROM public.fmv_confidence_precompute WHERE counts IS NULL AND slug <> 'ufc_strike' AND note IS NULL) THEN
    RAISE EXCEPTION 'a NULL counts row carries no note';
  END IF;
  IF has_function_privilege('anon', 'public.refresh_fmv_confidence_precompute()', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked'; END IF;
  IF has_function_privilege('authenticated', 'public.refresh_fmv_confidence_precompute()', 'EXECUTE') THEN RAISE EXCEPTION 'authenticated EXECUTE leaked'; END IF;
  IF NOT has_function_privilege('service_role', 'public.refresh_fmv_confidence_precompute()', 'EXECUTE') THEN RAISE EXCEPTION 'service_role lost EXECUTE'; END IF;
END $$;
