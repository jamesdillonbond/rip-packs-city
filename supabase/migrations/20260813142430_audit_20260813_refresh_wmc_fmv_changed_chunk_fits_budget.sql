-- audit_20260813 follow-up: shrink the chunk so the CLEAN EXIT actually happens.
--
-- The resumable version completed for the first time (1,743 rows) -- but took 30.31s,
-- i.e. right at service_role's 30s ceiling. In production that is a coin flip, and
-- LOSING it costs everything: a statement_timeout kill rolls back the whole function
-- call, INCLUDING the rwfc_state upsert, so a killed run banks nothing. Chunking only
-- buys durable progress if the function RETURNS before the kill.
--
-- Why 15 was too coarse: the deadline is only checked BETWEEN chunks, and this sweep
-- updates wmc GLOBALLY, so one 15-edition chunk is ~600 rows and ran ~8-12s. With a 15s
-- deadline that admits a second chunk which finishes near 25-30s.
--
-- chunk 15 -> 5 and deadline 15s -> 10s makes the granularity ~3-4s, so the last chunk
-- lands around 13s and the whole call returns near 15s -- half the budget, with room for
-- the instance to be slower than it is right now.
--
-- Throughput is not the constraint: the first successful run consumed ~2 minutes of
-- snapshot backlog in 30s (~4x realtime), so it converges even at a smaller chunk.
--
-- Signature unchanged -> no new overload, grants stand.
-- REVERT: re-apply audit_20260813_refresh_wmc_fmv_changed_resumable (chunk 15 / 15s).

CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_changed(
  p_since_minutes integer DEFAULT 30,
  p_limit integer DEFAULT 50000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total      integer := 0;
  v_batch      integer;
  v_cutoff     timestamptz;
  v_new_cutoff timestamptz;
  v_run_start  timestamptz := clock_timestamp();
  v_chunk      constant integer  := 5;
  v_budget     constant interval := interval '10 seconds';
  v_deadline   timestamptz := clock_timestamp() + v_budget;
BEGIN
  SELECT last_cutoff INTO v_cutoff FROM public.rwfc_state WHERE id = 1;
  IF v_cutoff IS NULL THEN
    v_cutoff := v_run_start - make_interval(mins => GREATEST(p_since_minutes, 1));
  END IF;

  DROP TABLE IF EXISTS _rwfc_recent;
  CREATE TEMP TABLE _rwfc_recent ON COMMIT DROP AS
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.computed_at
  FROM public.fmv_snapshots fs
  WHERE fs.computed_at > v_cutoff
    AND fs.fmv_usd IS NOT NULL
  ORDER BY fs.edition_id, fs.computed_at DESC;
  CREATE INDEX ON _rwfc_recent (computed_at);
  ANALYZE _rwfc_recent;

  LOOP
    WITH popped AS (
      DELETE FROM _rwfc_recent
       WHERE edition_id IN (
         SELECT edition_id FROM _rwfc_recent ORDER BY computed_at LIMIT v_chunk
       )
      RETURNING edition_id
    ),
    latest_fmv AS MATERIALIZED (
      SELECT e.collection_id, e.external_id,
        (SELECT f.fmv_usd
           FROM public.fmv_snapshots f
          WHERE f.edition_id = e.id
            AND f.fmv_usd IS NOT NULL
          ORDER BY f.computed_at DESC
          LIMIT 1) AS fmv_usd
      FROM popped p
      JOIN public.editions e ON e.id = p.edition_id
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd = lf.fmv_usd
        FROM latest_fmv lf
       WHERE wmc.collection_id = lf.collection_id
         AND wmc.edition_key   = lf.external_id
         AND wmc.edition_key IS NOT NULL
         AND lf.fmv_usd IS NOT NULL
         AND wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_batch FROM updated;

    v_total := v_total + COALESCE(v_batch, 0);

    EXIT WHEN NOT EXISTS (SELECT 1 FROM _rwfc_recent);
    EXIT WHEN clock_timestamp() > v_deadline;
    EXIT WHEN v_total >= p_limit;
  END LOOP;

  SELECT MIN(computed_at) - interval '1 microsecond' INTO v_new_cutoff FROM _rwfc_recent;
  v_new_cutoff := COALESCE(v_new_cutoff, v_run_start);

  INSERT INTO public.rwfc_state (id, last_cutoff) VALUES (1, v_new_cutoff)
  ON CONFLICT (id) DO UPDATE SET last_cutoff = EXCLUDED.last_cutoff;

  RETURN v_total;
END;
$function$;