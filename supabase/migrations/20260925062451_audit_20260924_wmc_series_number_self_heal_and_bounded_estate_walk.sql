-- 2026-09-24 (PT) — wallet_moments_cache.series_number is NULL on 940k of
-- 2.19M rows (TS 458k · All Day 433k · Candy 25k · Golazos 20k · UFC 3k)
-- whose EDITION carries the series. Two writers leave it empty: the on-chain
-- TopShotMomentMetadataView returns no seriesNumber for newer moments, and
-- wallet-search's `Number(r.series) || null` turns Top Shot's on-chain Series
-- 1 (= 0) into NULL. The metadata self-heal (backfill_wmc_metadata_from_editions,
-- COALESCE fill-only) never filled series_number, so the gap only grew: every
-- series breakdown over the cache (share card, analyzer filters, the analytics
-- series split) counted those moments as "No series".
--
-- Three parts:
--   1. backfill_wmc_metadata_from_editions fills series_number from
--      editions.series like the other five columns (guarded two-anchor splice
--      on the LIVE body, prosrc md5 15cd2c8a9e812865d09863ec1ed422bd) — the
--      per-wallet path every backfill route already calls. (A GLOBAL call —
--      p_wallet NULL — now has an OR arm idx_wmc_metadata_fillable does not
--      cover; nothing schedules one, and part 2 is the estate walk.)
--   2. A bounded one-time estate walk: backfill_wmc_series_batch(p_editions)
--      advances a per-collection cursor over editions (ordered by external_id,
--      the unique key with collection_id) and fills the cache rows of that
--      slice through idx_wmc_coll_ek_serial_cover; state in
--      wmc_series_backfill_state (RLS on); logged as pipeline
--      'wmc-series-backfill' with a count that means rows WRITTEN and its own
--      last_error.
--   3. pg_cron 'rpc-wmc-series-backfill' every minute; the function
--      unschedules the job itself once every collection is done.
-- Revert: cron.unschedule('rpc-wmc-series-backfill'); DROP FUNCTION
-- backfill_wmc_series_batch; DROP TABLE wmc_series_backfill_state; re-apply
-- the previous defining migration of backfill_wmc_metadata_from_editions
-- (the filled values are true and need no revert).

-- ── 1. self-heal fills series_number ────────────────────────────────────────
-- anon-exec: intentional — SPLICE of backfill_wmc_metadata_from_editions (service_role only; ACL untouched by CREATE OR REPLACE).
DO $$
DECLARE
  v_def text;
  v_a1 text := $a$           team_name   = COALESCE(wmc.team_name,   e.team_name)
      FROM public.editions e$a$;
  v_n1 text := $a$           team_name   = COALESCE(wmc.team_name,   e.team_name),
           -- 2026-09-24: series was the one column this fill skipped (940k NULLs).
           series_number = COALESCE(wmc.series_number, e.series::int)
      FROM public.editions e$a$;
  v_a2 text := $a$         (wmc.team_name   IS NULL AND e.team_name IS NOT NULL)
       )$a$;
  v_n2 text := $a$         (wmc.team_name   IS NULL AND e.team_name IS NOT NULL) OR
         (wmc.series_number IS NULL AND e.series IS NOT NULL)
       )$a$;
  v_c int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'backfill_wmc_metadata_from_editions';
  IF v_def IS NULL THEN RAISE EXCEPTION 'backfill_wmc_metadata_from_editions not found'; END IF;
  IF position('series_number' IN v_def) > 0 THEN
    RAISE NOTICE 'backfill_wmc_metadata_from_editions already fills series_number — no-op';
    RETURN;
  END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a1, ''))) / length(v_a1);
  IF v_c <> 1 THEN RAISE EXCEPTION 'SET anchor found % times', v_c; END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a2, ''))) / length(v_a2);
  IF v_c <> 1 THEN RAISE EXCEPTION 'predicate anchor found % times', v_c; END IF;
  EXECUTE replace(replace(v_def, v_a1, v_n1), v_a2, v_n2);
END $$;

-- ── 2. bounded estate walk ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wmc_series_backfill_state (
  collection_id       uuid PRIMARY KEY REFERENCES public.collections(id),
  cursor_external_id  text NOT NULL DEFAULT '',
  done                boolean NOT NULL DEFAULT false,
  rows_updated        bigint NOT NULL DEFAULT 0,
  batches             int NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wmc_series_backfill_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wmc_series_backfill_state FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.wmc_series_backfill_state IS
  '2026-09-24 one-time walk state for backfill_wmc_series_batch (wallet_moments_cache.series_number from editions.series). Drop with the function once every row is done.';

INSERT INTO public.wmc_series_backfill_state (collection_id)
SELECT DISTINCT e.collection_id FROM public.editions e WHERE e.series IS NOT NULL
ON CONFLICT (collection_id) DO NOTHING;

-- anon-exec: intentional — backfill_wmc_series_batch is a pg_cron/service_role writer; REVOKEd from PUBLIC, anon and authenticated below.
CREATE OR REPLACE FUNCTION public.backfill_wmc_series_batch(p_editions int DEFAULT 300)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '50s'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_coll      uuid;
  v_cursor    text;
  v_slug      text;
  v_n_ed      int := 0;
  v_last      text;
  v_updated   int := 0;
  v_ok        boolean := true;
  v_err       text;
BEGIN
  SELECT s.collection_id, s.cursor_external_id, c.slug
    INTO v_coll, v_cursor, v_slug
  FROM public.wmc_series_backfill_state s
  JOIN public.collections c ON c.id = s.collection_id
  WHERE NOT s.done
  ORDER BY s.collection_id
  LIMIT 1;

  IF v_coll IS NULL THEN
    -- Every collection walked: retire the schedule (idempotent).
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-wmc-series-backfill') THEN
      PERFORM cron.unschedule('rpc-wmc-series-backfill');
    END IF;
    RETURN 0;
  END IF;

  BEGIN
    -- One statement: the slice is a CTE (evaluated once), so no temp table
    -- and no plan-cache OID trap under a pooled session.
    WITH slice AS (
      SELECT e.external_id, e.series::int AS series
      FROM public.editions e
      WHERE e.collection_id = v_coll
        AND e.series IS NOT NULL
        AND e.external_id > v_cursor
      ORDER BY e.external_id
      LIMIT p_editions
    ),
    upd AS (
      UPDATE public.wallet_moments_cache wmc
         SET series_number = s.series
        FROM slice s
       WHERE wmc.collection_id = v_coll
         AND wmc.edition_key   = s.external_id
         AND wmc.series_number IS NULL
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM slice),
           (SELECT max(external_id) FROM slice),
           (SELECT count(*)::int FROM upd)
      INTO v_n_ed, v_last, v_updated;

    UPDATE public.wmc_series_backfill_state
       SET cursor_external_id = COALESCE(v_last, cursor_external_id),
           done         = (v_n_ed < p_editions),
           rows_updated = rows_updated + v_updated,
           batches      = batches + 1,
           updated_at   = now()
     WHERE collection_id = v_coll;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
    v_err := SQLERRM;
    v_updated := 0;
  END;

  PERFORM public.log_pipeline_run(
    'wmc-series-backfill', v_started,
    v_n_ed, v_updated, 0, v_ok, v_err, v_slug,
    v_cursor, v_last,
    jsonb_build_object('editions_in_slice', v_n_ed, 'rows_written', v_updated,
                       'elapsed_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000))
  );

  IF NOT v_ok THEN
    RAISE EXCEPTION 'backfill_wmc_series_batch(%): %', v_slug, v_err;
  END IF;
  RETURN v_updated;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.backfill_wmc_series_batch(int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.backfill_wmc_series_batch(int) TO service_role, postgres;

-- ── 3. schedule (every minute until the function retires it) ────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-wmc-series-backfill') THEN
    PERFORM cron.schedule('rpc-wmc-series-backfill', '* * * * *',
      'SELECT public.backfill_wmc_series_batch(300)');
  END IF;
END $$;

-- Post-conditions.
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'backfill_wmc_metadata_from_editions';
  IF position('series_number = COALESCE(wmc.series_number, e.series::int)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'self-heal splice did not land';
  END IF;
  IF (SELECT count(*) FROM public.wmc_series_backfill_state) < 5 THEN
    RAISE EXCEPTION 'walk state seeded % collections, expected 5', (SELECT count(*) FROM public.wmc_series_backfill_state);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-wmc-series-backfill') THEN
    RAISE EXCEPTION 'schedule missing';
  END IF;
END $$;
