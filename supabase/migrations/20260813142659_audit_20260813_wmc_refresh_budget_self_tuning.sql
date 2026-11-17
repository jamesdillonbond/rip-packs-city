-- audit_20260813: stop hard-coding the budget. Derive it from the CALLER's actual
-- statement_timeout, so the same function is correct under service_role (30s) and under
-- cron_heavy (600s).
--
-- WHY THIS, AND NOT ANOTHER CHUNK TWEAK. Measured the real throughput ceiling:
--   * snapshot inflow  ~1,718 distinct editions/hour
--   * route cadence    12 ticks/hour x 30s budget = ~6 MINUTES of DB time per hour
--   * cost per edition ~50 wmc rows, each a NON-HOT update maintaining 15 indexes
-- The global sweep therefore cannot keep up no matter how the chunk is sized -- 6
-- minutes of a 30s-capped API role per hour is simply less work than the inflow needs.
-- Shrinking chunks made each call SAFE (17.3s, clean exit) without making the sweep
-- SUFFICIENT: rwfc backlog sat at 1,119 editions against ~1,718/hour arriving.
--
-- The fix is the ROLE, not the loop. These are maintenance sweeps and belong on pg_cron
-- under cron_heavy (statement_timeout 600s), which is exactly what the rest of this
-- estate's heavy work uses. But the route still calls them too, so the function has to
-- be correct under BOTH budgets -- hence self-tuning rather than a second hard-coded
-- constant that the next caller silently violates.
--
-- HOW THE BUDGET IS READ: pg_settings.setting for statement_timeout is always in
-- MILLISECONDS with unit='ms', which is unambiguous. current_setting() returns the
-- display form ('30s', '10min', '0') and parsing that is a footgun -- a bare '30000'
-- would cast to 30000 SECONDS as an interval, i.e. 1000x the real budget.
-- 0 means unlimited (pg_cron with no role cap); fall back to 300s rather than looping
-- unbounded.
--
-- Deadline = 60% of the budget, floored at 5s, so the last chunk plus the state upsert
-- land well inside the kill. A statement_timeout kill rolls back the WHOLE call
-- including the watermark write, so returning early is what makes progress durable --
-- that is the entire point of the deadline.
--
-- Signature unchanged -> no new overload, grants stand. cron_heavy EXECUTE is granted
-- below because a pg_cron job owned by cron_heavy needs it even on a SECURITY DEFINER
-- function (the 2026-08-10 M3b lesson).
--
-- REVERT: re-apply audit_20260813_refresh_wmc_fmv_changed_chunk_fits_budget
--         (fixed chunk 5 / fixed 10s deadline), then
--         REVOKE EXECUTE ON FUNCTION public.refresh_wmc_fmv_changed(integer,integer) FROM cron_heavy;

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
  v_timeout_ms bigint;
  v_budget     interval;
  v_chunk      integer;
  v_deadline   timestamptz;
BEGIN
  SELECT setting::bigint INTO v_timeout_ms FROM pg_settings WHERE name = 'statement_timeout';

  IF v_timeout_ms IS NULL OR v_timeout_ms = 0 THEN
    v_budget := interval '300 seconds';          -- uncapped caller; stay bounded anyway
  ELSE
    v_budget := GREATEST(make_interval(secs => (v_timeout_ms / 1000.0) * 0.6),
                         interval '5 seconds');
  END IF;

  -- Small chunks keep the deadline check fine-grained on a 30s API budget; a 600s
  -- cron_heavy run can afford far coarser ones and wants fewer round trips.
  v_chunk := CASE WHEN v_budget >= interval '60 seconds' THEN 100 ELSE 5 END;
  v_deadline := clock_timestamp() + v_budget;

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

GRANT EXECUTE ON FUNCTION public.refresh_wmc_fmv_changed(integer, integer) TO cron_heavy;
GRANT SELECT, INSERT, UPDATE ON public.rwfc_state TO cron_heavy;