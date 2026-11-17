DO $mig$
DECLARE
  def     text;
  marker  text := ')' || chr(10) || ' SELECT metric,';
  newarm  text;
  newdef  text;
  hits    int;
BEGIN
  def := pg_get_viewdef('public.v_rpc_trust_health'::regclass, true);

  hits := (length(def) - length(replace(def, marker, ''))) / length(marker);
  IF hits <> 1 THEN
    RAISE EXCEPTION 'splice marker found % times, expected exactly 1 - aborting', hits;
  END IF;

  IF position('fmv_sweep_stall_pct_24h' in def) > 0 THEN
    RAISE EXCEPTION 'arm fmv_sweep_stall_pct_24h already present - aborting';
  END IF;

  newarm := $arm$        UNION ALL
         SELECT 'fmv_sweep_stall_pct_24h'::text AS metric,
            ( SELECT CASE
                       WHEN count(*) = 0 THEN 999::numeric
                       ELSE round(100.0 * count(*) FILTER (WHERE pr.cursor_before = '0'::text)::numeric / count(*)::numeric, 1)
                     END
                FROM pipeline_runs pr
               WHERE pr.pipeline = 'fmv-recalc'::text
                 AND pr.started_at > (now() - '24:00:00'::interval)) AS value,
            50::numeric AS breach_at,
            'the fmv-recalc catalogue sweep silently restarting at page 0 instead of advancing. The route pages editions with a cursor persisted in pipeline_runs.cursor_after and computes hasMore as pageEditionIds.length === limit; PostgREST caps RPC results at db-max-rows=1000, so a 2500-row request returns 1000, hasMore is false, cursor_after is written NULL, and the next run resets to offset 0. Discovered 2026-08-03: every run for 20h logged cursor_before=0 / cursor_after=NULL / rows_written=997, leaving 74pct of the 11602 editions in the 30d sales window never recomputed by the current algo -- including the dust-floor removal, which reached only the most-recently-traded head. Measures the share of fmv-recalc runs in 24h that started at cursor_before=0: a healthy 13-page sweep is about 8pct, a stuck sweep is 100pct. 999 when there are no runs at all, because absence must not read as health. This is the arm that topshot_fmv_stale_hours structurally cannot be (it reads only the freshest row, and a head-pinned sweep writes fresh rows constantly) and that topshot_fmv_pct_stale_30d failed to be (its 2026-07-25 baseline of 32.3pct was captured while the sweep was already stuck, so breach_at was set 18 points above the broken steady state and a permanent plateau produces no trend)'::text AS catches
$arm$;

  newdef := replace(def, marker, newarm || marker);

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || newdef;
END
$mig$;