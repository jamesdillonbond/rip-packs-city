-- audit_20261102_226_topshot_map_reconciles_with_atlas
--
-- #226 — a daily self-healing lane for the Top Shot moment→edition attribution.
--
-- WHY: `topshot_moment_subeditions.base_external_id` is seeded by COPYING our own sales / wmc
-- attribution, `/api/sales-indexer` then resolves new sales FROM that map and wmc, and nothing reads a
-- moment's set/play from chain — so one wrong attribution re-seeds itself (a 2026-10-24 offer_fill
-- sale was the loop in action). 2026-11-02 measured, all repaired by hand that day:
--   * 258 moments chain-read (Flow REST borrowMoment) wrong, 0 right, in the "new id on an old set" cut;
--   * Atlas (`topshot_atlas_market_events`, Dapper's own marketplace index) vs chain: 135 / 135 agree
--     (116 among the chain-verified rows + 19 spot checks across every disagreement kind);
--   * map vs Atlas over every moment Atlas knows unanimously: 279,710 compared, 533 disagree → 530
--     repaired (3 left where Atlas' Standard/parallel label contradicts the chain-read subedition).
-- WHAT: once a day, rows where Atlas is UNANIMOUS on (set, play) for a moment, the map disagrees, the
-- subedition (read from chain by backfill-topshot-subeditions) agrees with Atlas' Standard/parallel
-- label, and the target edition exists, are repointed in every attribution copy:
--   topshot_moment_subeditions.base_external_id · wallet_moments_cache.edition_key · sales.edition_id ·
--   moments.edition_id (skipped where (target, serial) is already another nft's) · topshot_moment_id_editions.
-- Each candidate is written to `topshot_atlas_reconcile_log` FIRST (run_id, from, to); the updates join
-- on that run's rows, and the per-row counts land back on the log. Capped at p_max per run.
-- COST: the detection read is ~12 s / ~3.5M buffer hits (measured 11-02, warm) — hence DAILY, off-peak.
-- It does not cover moments Atlas has never seen (no marketplace trade in its index).
-- VERIFIED 11-02 ~10:22 AM PT (positive control): one repaired map row was set back to its known-wrong base
-- (nft 100253 → 2:244); a manual run found exactly 1 candidate, put it back on Atlas' 2:151 and logged ok.
-- REVERT: SELECT cron.unschedule('rpc-topshot-map-atlas-reconcile');
--         per row: topshot_atlas_reconcile_log holds from_key/to_key for every change it made.

CREATE TABLE IF NOT EXISTS public.topshot_atlas_reconcile_log (
  run_id      uuid        NOT NULL,
  nft_id      text        NOT NULL,
  from_base   text        NOT NULL,
  to_base     text        NOT NULL,
  subedition  integer     NOT NULL,
  to_key      text        NOT NULL,
  wmc_rows    integer,
  sales_rows  integer,
  moment_rows integer,
  idmap_rows  integer,
  logged_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, nft_id)
);
ALTER TABLE public.topshot_atlas_reconcile_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_atlas_reconcile_log FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.topshot_atlas_reconcile_log IS
  '#226: every moment the daily Atlas reconcile repointed (from map base -> Atlas base), with per-table row counts. Revert source.';

CREATE OR REPLACE FUNCTION public.reconcile_topshot_map_with_atlas(p_max integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  ts       constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_run    uuid := gen_random_uuid();
  v_start  timestamptz := clock_timestamp();
  v_cand   int := 0; v_sub int := 0; v_wmc int := 0; v_sales int := 0; v_mom int := 0; v_idm int := 0;
  v_err    text;
BEGIN
  BEGIN
    INSERT INTO public.topshot_atlas_reconcile_log (run_id, nft_id, from_base, to_base, subedition, to_key)
    SELECT v_run, c.nft_id, c.old_base, c.new_base, c.sub,
           c.new_base || CASE WHEN c.sub > 0 THEN '::' || c.sub ELSE '' END
      FROM (
        SELECT t.nft_id, t.base_external_id AS old_base, COALESCE(t.subedition_id, 0) AS sub,
               ev.s::text || ':' || ev.p::text AS new_base
          FROM (SELECT nft_id, min(set_id_onchain) AS s, min(play_id_onchain) AS p, bool_and(parallel = 'Standard') AS std
                  FROM public.topshot_atlas_market_events
                 WHERE product = 'nba' AND set_id_onchain IS NOT NULL AND play_id_onchain IS NOT NULL
                 GROUP BY nft_id
                HAVING count(DISTINCT (set_id_onchain, play_id_onchain)) = 1) ev
          JOIN public.topshot_moment_subeditions t ON t.nft_id = ev.nft_id
         WHERE t.subedition_id IS NOT NULL
           AND t.base_external_id <> ev.s::text || ':' || ev.p::text
           AND (t.subedition_id > 0) <> ev.std
      ) c
     WHERE EXISTS (SELECT 1 FROM public.editions e WHERE e.collection_id = ts
                      AND e.external_id = c.new_base || CASE WHEN c.sub > 0 THEN '::' || c.sub ELSE '' END)
     ORDER BY c.nft_id
     LIMIT GREATEST(p_max, 0);
    GET DIAGNOSTICS v_cand = ROW_COUNT;

    IF v_cand > 0 THEN
      UPDATE public.topshot_moment_subeditions t SET base_external_id = l.to_base
        FROM public.topshot_atlas_reconcile_log l WHERE l.run_id = v_run AND l.nft_id = t.nft_id;
      GET DIAGNOSTICS v_sub = ROW_COUNT;

      WITH u AS (
        UPDATE public.wallet_moments_cache w SET edition_key = l.to_key
          FROM public.topshot_atlas_reconcile_log l
         WHERE l.run_id = v_run AND w.collection_id = ts AND w.moment_id = l.nft_id AND w.edition_key <> l.to_key
        RETURNING w.moment_id)
      UPDATE public.topshot_atlas_reconcile_log l SET wmc_rows = x.n
        FROM (SELECT moment_id, count(*) n FROM u GROUP BY 1) x WHERE l.run_id = v_run AND l.nft_id = x.moment_id;

      WITH u AS (
        UPDATE public.sales s SET edition_id = tg.id
          FROM public.topshot_atlas_reconcile_log l, public.editions tg
         WHERE l.run_id = v_run AND s.collection_id = ts AND s.nft_id = l.nft_id
           AND tg.collection_id = ts AND tg.external_id = l.to_key AND s.edition_id <> tg.id
        RETURNING s.nft_id)
      UPDATE public.topshot_atlas_reconcile_log l SET sales_rows = x.n
        FROM (SELECT nft_id, count(*) n FROM u GROUP BY 1) x WHERE l.run_id = v_run AND l.nft_id = x.nft_id;

      WITH u AS (
        UPDATE public.moments m SET edition_id = tg.id, updated_at = now()
          FROM public.topshot_atlas_reconcile_log l, public.editions tg
         WHERE l.run_id = v_run AND m.collection_id = ts AND m.nft_id = l.nft_id
           AND tg.collection_id = ts AND tg.external_id = l.to_key AND m.edition_id <> tg.id
           AND NOT EXISTS (SELECT 1 FROM public.moments o WHERE o.edition_id = tg.id
                              AND o.serial_number = m.serial_number AND o.nft_id <> m.nft_id)
        RETURNING m.nft_id)
      UPDATE public.topshot_atlas_reconcile_log l SET moment_rows = x.n
        FROM (SELECT nft_id, count(*) n FROM u GROUP BY 1) x WHERE l.run_id = v_run AND l.nft_id = x.nft_id;

      WITH u AS (
        UPDATE public.topshot_moment_id_editions i SET edition_external_id = l.to_key
          FROM public.topshot_atlas_reconcile_log l
         WHERE l.run_id = v_run AND l.nft_id ~ '^[0-9]{1,18}$' AND i.id = l.nft_id::bigint AND i.edition_external_id <> l.to_key
        RETURNING i.id::text AS nft_id)
      UPDATE public.topshot_atlas_reconcile_log l SET idmap_rows = 1
        FROM u WHERE l.run_id = v_run AND l.nft_id = u.nft_id;

      SELECT COALESCE(sum(wmc_rows),0), COALESCE(sum(sales_rows),0), COALESCE(sum(moment_rows),0), COALESCE(sum(idmap_rows),0)
        INTO v_wmc, v_sales, v_mom, v_idm
        FROM public.topshot_atlas_reconcile_log WHERE run_id = v_run;
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run(
    'topshot-map-atlas-reconcile', v_start, v_cand, CASE WHEN v_err IS NULL THEN v_sub ELSE 0 END, 0,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('run_id', v_run, 'candidates', v_cand, 'map_rows', v_sub, 'wmc_rows', v_wmc,
                       'sales_rows', v_sales, 'moment_rows', v_mom, 'idmap_rows', v_idm, 'cap', p_max,
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_start) * 1000)::int));
  RETURN jsonb_build_object('ok', v_err IS NULL, 'run_id', v_run, 'candidates', v_cand, 'map_rows', v_sub,
                            'wmc_rows', v_wmc, 'sales_rows', v_sales, 'moment_rows', v_mom, 'idmap_rows', v_idm, 'error', v_err);
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_topshot_map_with_atlas(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_topshot_map_with_atlas(integer) TO service_role;
COMMENT ON FUNCTION public.reconcile_topshot_map_with_atlas(integer) IS
  '#226 daily: repoint Top Shot attribution (map, wmc, sales, moments, id map) to the edition Atlas names unanimously, where the chain-read subedition agrees. Log: topshot_atlas_reconcile_log.';

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES ('topshot-map-atlas-reconcile', 1560, 'medium',
        'Daily 4:47 AM PT: repoints Top Shot moment attribution to Atlas-unanimous editions (#226). Logs every run.',
        true)
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-topshot-map-atlas-reconcile', '47 12 * * *', 'SELECT public.reconcile_topshot_map_with_atlas(500)');
