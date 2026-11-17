-- 2026-10-18 (Claude Code cloud) — refresh_panini_pack_ev_sim's pipeline row reports the row it WROTE.
--
-- WHY: the 3-arg `log_pipeline_run(text, boolean, jsonb)` wrapper fills pipeline_runs.rows_written from
-- p_extra->>'upserted' and COALESCEs a missing key to 0. This function put its count under 'rows_written'
-- in extra, so every hourly run published rows_written = 0 while writing its one row (panini_pack_ev_sim
-- computed_at advanced every hour; 4 of 4 runs on 10-18 read 0). A count must mean rows WRITTEN (R120/R123).
-- One key added; the body is otherwise identical to 20261018162610 (live prosrc md5 verified equal first).
-- The wrapper's COALESCE-to-0 for the other callers is filed separately: check_zero_yield_lanes keys on
-- found = 0, so a NULL there would silently drop lanes from that guard — not a change to make in passing.
--
-- anon-exec: unchanged (refresh_panini_pack_ev_sim) — CREATE OR REPLACE of an existing fn, same signature; ACL (service_role only) preserved.

CREATE OR REPLACE FUNCTION public.refresh_panini_pack_ev_sim(p_sims integer DEFAULT 20000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_cost    numeric;
  v_n       integer;
  v_mean    numeric;
  v_median  numeric;
  v_p       numeric;
  v_written integer;
BEGIN
  SELECT pack_cost_usd INTO v_cost FROM public.panini_pack_ev_board WHERE id = '1038';

  WITH ed AS (
    SELECT CASE
             WHEN e.set_name ~~* 'Base Prizms Silver' THEN 'silver'
             WHEN e.parallel_family = 'fotl_exclusive' THEN 'fotl'
             WHEN e.parallel_family = 'base' THEN 'base'
             ELSE 'insert'
           END AS cls,
           COALESCE(e.still_in_packs, 0) AS w,
           (SELECT fs.fmv_usd FROM public.panini_fmv_snapshots fs
             WHERE fs.edition_id = e.id ORDER BY fs.computed_at DESC LIMIT 1) AS fmv
      FROM public.panini_editions e
     WHERE e.external_id ~~ 'packcard-2332\_%'
  ), pr AS (
    SELECT cls, w, fmv FROM ed WHERE fmv IS NOT NULL AND w > 0
  ), fam AS (
    SELECT cls, array_agg(lo ORDER BY rn) AS lo, array_agg(fmv ORDER BY rn) AS v, sum(w)::float8 AS tot
      FROM (SELECT cls, fmv, w,
                   row_number() OVER (PARTITION BY cls ORDER BY fmv, w) AS rn,
                   COALESCE(sum(w) OVER (PARTITION BY cls ORDER BY fmv, w
                                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::float8 AS lo
              FROM pr) x
     GROUP BY cls
  ), f AS (
    SELECT (SELECT lo FROM fam WHERE cls = 'silver') AS s_lo, (SELECT v FROM fam WHERE cls = 'silver') AS s_v,
           (SELECT tot FROM fam WHERE cls = 'silver') AS s_t,
           (SELECT lo FROM fam WHERE cls = 'base') AS b_lo, (SELECT v FROM fam WHERE cls = 'base') AS b_v,
           (SELECT tot FROM fam WHERE cls = 'base') AS b_t,
           (SELECT lo FROM fam WHERE cls = 'insert') AS i_lo, (SELECT v FROM fam WHERE cls = 'insert') AS i_v,
           (SELECT tot FROM fam WHERE cls = 'insert') AS i_t
  ), packs AS (
    SELECT f.s_v[width_bucket(random() * f.s_t, f.s_lo)]
         + f.s_v[width_bucket(random() * f.s_t, f.s_lo)]
         + f.b_v[width_bucket(random() * f.b_t, f.b_lo)]
         + CASE WHEN random() < 0.65 THEN f.b_v[width_bucket(random() * f.b_t, f.b_lo)]
                ELSE f.i_v[width_bucket(random() * f.i_t, f.i_lo)] END AS val
      FROM f, generate_series(1, GREATEST(p_sims, 1000))
     WHERE f.s_t > 0 AND f.b_t > 0 AND f.i_t > 0
  )
  SELECT count(*), avg(val), percentile_cont(0.5) WITHIN GROUP (ORDER BY val),
         CASE WHEN v_cost > 0 THEN avg((val >= v_cost)::int) END
    INTO v_n, v_mean, v_median, v_p
    FROM packs;

  IF COALESCE(v_n, 0) = 0 THEN
    RAISE EXCEPTION 'no simulated packs: a card family has no priced, in-pack edition';
  END IF;

  INSERT INTO public.panini_pack_ev_sim AS t (pack_id, sims, mean_pull_usd, median_pull_usd, p_beat_cost, cost_usd, computed_at, ok, error)
  VALUES ('1038', v_n, round(v_mean, 2), round(v_median, 2), round(v_p, 4), v_cost, now(), true, NULL)
  ON CONFLICT (pack_id) DO UPDATE
    SET sims = EXCLUDED.sims, mean_pull_usd = EXCLUDED.mean_pull_usd, median_pull_usd = EXCLUDED.median_pull_usd,
        p_beat_cost = EXCLUDED.p_beat_cost, cost_usd = EXCLUDED.cost_usd, computed_at = EXCLUDED.computed_at,
        ok = true, error = NULL;
  GET DIAGNOSTICS v_written = ROW_COUNT;

  PERFORM public.log_pipeline_run('panini-pack-ev-sim', v_written = 1,
    jsonb_build_object('sims', v_n, 'median', round(v_median, 2), 'p_beat_cost', round(v_p, 4),
                       'cost_usd', v_cost, 'rows_written', v_written, 'upserted', v_written));
  RETURN jsonb_build_object('ok', v_written = 1, 'sims', v_n, 'mean', round(v_mean, 2),
                            'median', round(v_median, 2), 'p_beat_cost', round(v_p, 4), 'cost_usd', v_cost);
EXCEPTION WHEN query_canceled OR OTHERS THEN
  INSERT INTO public.panini_pack_ev_sim AS t (pack_id, sims, computed_at, ok, error)
  VALUES ('1038', 0, now(), false, SQLERRM)
  ON CONFLICT (pack_id) DO UPDATE
    SET sims = 0, mean_pull_usd = NULL, median_pull_usd = NULL, p_beat_cost = NULL, cost_usd = NULL,
        computed_at = now(), ok = false, error = EXCLUDED.error;
  PERFORM public.log_pipeline_run('panini-pack-ev-sim', false, jsonb_build_object('error', SQLERRM));
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

