-- R118, third batch (2026-09-20 ~8:30 AM PT, Cowork cloud): the FOURTEEN pinned functions.
-- `EXCEPTION WHEN OTHERS` does not catch query_canceled (57014) — proof and first batches in
-- 20260920140611 (five wrappers) and 20260920143546 (sixteen unpinned; see the file that
-- precedes this one). These fourteen are drift-guard pinned (supabase/tests/<fn>.sql ↔ the
-- migration registered in __tests__/db-invariants-drift-guard.test.ts), so they take the
-- literal-DDL route: each block below is the pin's verbatim DDL (byte-identical to live prosrc,
-- md5 checked for all fourteen at 8:20 AM PT) with the one-token change per handler, and the
-- same text is written back into each pin. The md5 of every new body was computed in the DB
-- from the live body (regexp_replace on prosrc) and matched against these blocks BEFORE apply,
-- so no hand transcription is trusted anywhere in this file.
--
-- The eight rpc_thp_leg_* legs are the trust board's 999-on-failure sentinels — the pattern
-- whose blindness left `topshot_impossible_parallel_serials` frozen through four 600 s kills
-- tonight. The six others (refresh_allday_badge_low_ask, refresh_golazos_badge_low_ask,
-- refresh_insights_new_collectors, refresh_topshot_special_serial_owners_mv,
-- run_topshot_onchain_rekey, refresh_atlas_pack_ev) all record-and-exit (pipeline_runs row or
-- an error object) — the shape where catching the cancel is strictly better.
-- Same signatures ⇒ ACLs preserved. The pre-flight DO block refuses to run if any live body
-- differs from what was read; the post-flight one asserts the handlers changed.
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
--
-- EXIT: check_when_others_timeout_blind() (this pass) lists none of these; the next 600 s kill
--   of any leg writes its 999 AND the terminal thp-leg-* row.
-- REVERT: re-apply each function's previously registered migration body (the WHEN OTHERS form).
--
-- anon-exec: intentional — same signatures, existing ACLs preserved on all fourteen; pg_cron / cron_heavy / service_role callers only (rpc_thp_leg_board_liveness, rpc_thp_leg_fmv_coverage, rpc_thp_leg_fmv_sanity, rpc_thp_leg_impossible_parallel, rpc_thp_leg_pack_ev, rpc_thp_leg_panini, rpc_thp_leg_pinnacle_fmv_share, rpc_thp_leg_serial_supply, refresh_allday_badge_low_ask, refresh_golazos_badge_low_ask, refresh_insights_new_collectors, refresh_topshot_special_serial_owners_mv, run_topshot_onchain_rekey, refresh_atlas_pack_ev)

DO $$
DECLARE r record; v_expected jsonb := '{
  "refresh_allday_badge_low_ask": "912d6234770c3d9421936f70c17370af",
  "refresh_atlas_pack_ev": "4d65a354e86c60df8885ea17358f78f5",
  "refresh_golazos_badge_low_ask": "dabae900668b302648a047269514c385",
  "refresh_insights_new_collectors": "80cbc1f4a56eaea56be16b2ccc794350",
  "refresh_topshot_special_serial_owners_mv": "ce69e3d0c67718431f35428454f6b28f",
  "rpc_thp_leg_board_liveness": "6b185d6c55f8f771f91937f528829f1a",
  "rpc_thp_leg_fmv_coverage": "7870d0d9bfe277d0bdbf8a1fbfaf8bf6",
  "rpc_thp_leg_fmv_sanity": "6fd1b7d2f3d677c33c6bc5eb46c1ecf2",
  "rpc_thp_leg_impossible_parallel": "cc8cd240883778d9fee9eeedfbe2594c",
  "rpc_thp_leg_pack_ev": "276924efe28393436e7c1be723c8fc79",
  "rpc_thp_leg_panini": "cd17ea03afa19f87dda6b229f7fcacdc",
  "rpc_thp_leg_pinnacle_fmv_share": "9c34d6c14e91073db4613f6bcbdab2ba",
  "rpc_thp_leg_serial_supply": "3834a9d7d6e435e0ff4b63776894ece9",
  "run_topshot_onchain_rekey": "7ff09888640e61cb7c212e8d19c89f25"
}'::jsonb;
BEGIN
  FOR r IN SELECT p.proname, md5(p.prosrc) AS m FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname IN (SELECT jsonb_object_keys(v_expected)) LOOP
    IF r.m <> (v_expected ->> r.proname) THEN
      RAISE EXCEPTION 'R118: % live body differs from the pin this file was built from (md5 % vs %)', r.proname, r.m, v_expected ->> r.proname;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.refresh_allday_badge_low_ask()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_coll uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_start timestamptz := clock_timestamp();
  v_updated int := 0;
  v_cleared int := 0;
BEGIN
  WITH src AS (
    SELECT e.external_id, afa.floor_ask
    FROM allday_edition_floor_ask afa
    JOIN editions e ON e.id = afa.edition_id AND e.collection_id = v_coll
    WHERE afa.floor_ask > 0
  ),
  upd AS (
    UPDATE badge_editions be
    SET low_ask = src.floor_ask, updated_at = now()
    FROM src
    WHERE be.collection_id = v_coll
      AND be.external_id = src.external_id
      AND be.low_ask IS DISTINCT FROM src.floor_ask
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;

  WITH present AS (
    SELECT e.external_id
    FROM allday_edition_floor_ask afa
    JOIN editions e ON e.id = afa.edition_id AND e.collection_id = v_coll
    WHERE afa.floor_ask > 0
  ),
  cl AS (
    UPDATE badge_editions be
    SET low_ask = NULL, updated_at = now()
    WHERE be.collection_id = v_coll
      AND be.low_ask IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM present p WHERE p.external_id = be.external_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_cleared FROM cl;

  INSERT INTO pipeline_runs (pipeline, collection_slug, started_at, finished_at, rows_written, ok, extra)
  VALUES ('allday-badge-low-ask-refresh', 'nfl_all_day', v_start, clock_timestamp(),
          v_updated + v_cleared, true,
          jsonb_build_object('updated', v_updated, 'cleared', v_cleared));
EXCEPTION WHEN query_canceled OR OTHERS THEN
  INSERT INTO pipeline_runs (pipeline, collection_slug, started_at, finished_at, ok, error)
  VALUES ('allday-badge-low-ask-refresh', 'nfl_all_day', v_start, clock_timestamp(), false, SQLERRM);
  RAISE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_atlas_pack_ev()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_cid uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  r record;
  ev jsonb;
  v_gross numeric;
  v_typical numeric;
  v_written int := 0;
  v_now timestamptz := now();
BEGIN
  FOR r IN
    SELECT DISTINCT p.dist_id,
           pd.metadata->>'uuid' AS listing_uuid,
           COALESCE(pd.title, pd.metadata->>'name') AS title,
           GREATEST(COALESCE((pd.metadata->>'number_of_pack_slots')::int, 1), 1) AS slots,
           pas.lowest_ask,
           pd.total_sealed,
           pd.depletion_pct
    FROM pack_drop_pool p
    JOIN pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = p.dist_id
    LEFT JOIN pack_ask_state pas ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = p.dist_id
                                 AND pas.is_listed IS TRUE AND pas.lowest_ask > 0
    WHERE p.collection_id = v_cid AND p.pool_source = 'atlas'
  LOOP
    ev := public.compute_pack_ev_per_edition_weighted(v_cid, r.dist_id, COALESCE(r.lowest_ask, 0), r.slots);
    IF (ev->>'ok')::boolean IS NOT TRUE THEN
      INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
        primary_price, secondary_ask, price_source, primary_available, secondary_available,
        gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
      VALUES (r.listing_uuid, v_cid, r.dist_id, r.title, COALESCE(r.lowest_ask,0),
        NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
        false, r.lowest_ask > 0, 0, NULL, 0, false, NULL, NULL, 0, 0, 100, v_now);
      v_written := v_written + 1;
      CONTINUE;
    END IF;
    v_gross := (ev->>'gross_ev')::numeric;
    v_typical := (ev->>'typical_pull_ev')::numeric;
    INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
      primary_price, secondary_ask, price_source, primary_available, secondary_available,
      gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
    VALUES (
      r.listing_uuid, v_cid, r.dist_id, r.title, COALESCE(r.lowest_ask, 0),
      NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
      false, r.lowest_ask > 0,
      v_gross, v_typical,
      round(v_gross - COALESCE(r.lowest_ask, 0), 2),
      (r.lowest_ask > 0 AND (v_gross - r.lowest_ask) > 0),
      CASE WHEN r.lowest_ask > 0 THEN round(v_gross / r.lowest_ask, 3) ELSE NULL END,
      (ev->>'fmv_coverage_pct')::smallint, LEAST((ev->>'edition_count')::int, 32767), r.total_sealed, r.depletion_pct, v_now);
    v_written := v_written + 1;
  END LOOP;

  PERFORM public.log_pipeline_run('topshot-atlas-pack-ev', v_now, v_written, v_written, 0, true, NULL,
    'nba-top-shot', NULL, NULL, jsonb_build_object('rows', v_written));
  RETURN jsonb_build_object('ok', true, 'written', v_written, 'finished_at', now());
EXCEPTION WHEN query_canceled OR OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'written', v_written);
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_golazos_badge_low_ask()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_coll uuid := '06248cc4-b85f-47cd-af67-1855d14acd75';
  v_start timestamptz := clock_timestamp();
  v_updated int := 0;
  v_cleared int := 0;
  v_resolved int := 0;
BEGIN
  -- Self-heal edition_id on newly indexed listings before reading the view.
  v_resolved := public.resolve_golazos_listing_edition_ids();

  WITH src AS (
    SELECT e.external_id, gfa.floor_ask
    FROM public.golazos_edition_floor_ask gfa
    JOIN public.editions e ON e.id = gfa.edition_id AND e.collection_id = v_coll
    WHERE gfa.floor_ask > 0
  ),
  upd AS (
    UPDATE public.badge_editions be
    SET low_ask = src.floor_ask, updated_at = now()
    FROM src
    WHERE be.collection_id = v_coll
      AND be.external_id = src.external_id
      AND be.low_ask IS DISTINCT FROM src.floor_ask
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;

  WITH present AS (
    SELECT e.external_id
    FROM public.golazos_edition_floor_ask gfa
    JOIN public.editions e ON e.id = gfa.edition_id AND e.collection_id = v_coll
    WHERE gfa.floor_ask > 0
  ),
  cl AS (
    UPDATE public.badge_editions be
    SET low_ask = NULL, updated_at = now()
    WHERE be.collection_id = v_coll
      AND be.low_ask IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM present p WHERE p.external_id = be.external_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_cleared FROM cl;

  INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, rows_written, ok, extra)
  VALUES ('golazos-badge-low-ask-refresh', 'laliga_golazos', v_start, clock_timestamp(),
          v_updated + v_cleared, true,
          jsonb_build_object('updated', v_updated, 'cleared', v_cleared,
                             'listing_edition_ids_resolved', v_resolved));
EXCEPTION WHEN query_canceled OR OTHERS THEN
  INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, ok, error)
  VALUES ('golazos-badge-low-ask-refresh', 'laliga_golazos', v_start, clock_timestamp(), false, SQLERRM);
  RAISE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_insights_new_collectors()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_rows int;
BEGIN
  REFRESH MATERIALIZED VIEW public.mv_ts_buyer_first_buy;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_summary;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_spend;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_gateway;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_cohorts;
  SELECT count(*) INTO v_rows FROM public.mv_ts_buyer_first_buy;
  INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, ok, rows_written, extra)
  VALUES ('refresh-new-collectors', 'nba_top_shot', v_start, clock_timestamp(), true, v_rows,
          jsonb_build_object('buyers', v_rows));
EXCEPTION WHEN query_canceled OR OTHERS THEN
  INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, ok, error)
  VALUES ('refresh-new-collectors', 'nba_top_shot', v_start, clock_timestamp(), false, SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_topshot_special_serial_owners_mv()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '200s'
 SET enable_nestloop TO 'off'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.topshot_special_serial_owners_mv;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.allday_special_serial_owners_mv;
  PERFORM public.log_pipeline_run(
    p_pipeline   => 'refresh-special-serial-owners-mv',
    p_started_at => v_started,
    p_ok         => true,
    p_extra      => jsonb_build_object(
      'duration_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'logged_by', 'fn',
      'mvs', 'topshot+allday'
    )
  );
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run(
    p_pipeline   => 'refresh-special-serial-owners-mv',
    p_started_at => v_started,
    p_ok         => false,
    p_error      => SQLERRM,
    p_extra      => jsonb_build_object(
      'duration_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'logged_by', 'fn'
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_board_liveness()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '300s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v_board jsonb; v_empty numeric; v_slow numeric;
BEGIN
  BEGIN
    BEGIN
      SELECT public.public_board_liveness_probe() INTO v_board;
      IF COALESCE((v_board->>'budget_exhausted')::boolean, false) THEN
        v_empty := 999; v_slow := 999;   -- incomplete sweep is INCONCLUSIVE, not green
      ELSE
        v_empty := (v_board->>'empty_or_error')::numeric;
        v_slow  := (v_board->>'slow')::numeric;
      END IF;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_empty := 999; v_slow := 999;
    END;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('public_board_empty_count', v_empty, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)),
           ('public_board_slow_count',  v_slow, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['public_board_empty_count','public_board_slow_count']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_fmv_coverage()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public, pg_temp'
SET statement_timeout = '240s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp();
BEGIN
  BEGIN
    WITH latest AS (
      SELECT DISTINCT ON (fs.collection_id, fs.edition_id)
             fs.collection_id, fs.edition_id, fs.computed_at, fs.confidence
      FROM public.fmv_snapshots fs
      ORDER BY fs.collection_id, fs.edition_id, fs.computed_at DESC
    ),
    elig AS (
      SELECT l.collection_id, l.edition_id, l.computed_at, l.confidence
      FROM latest l
    ),
    agg AS (
      SELECT elig.collection_id,
             round(100.0 * count(*) FILTER (WHERE elig.computed_at < (now() - '30 days'::interval))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS pct_stale_30d,
             round(100.0 * count(*) FILTER (WHERE elig.confidence IN ('HIGH','MEDIUM'))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS high_med_pct,
             -- Sweep completeness: how much of the estate this reading actually refreshed.
             round(100.0 * count(*) FILTER (WHERE elig.computed_at >= (now() - '24 hours'::interval))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS sweep_pct_24h,
             -- The share over a CONSISTENT population. Denominator is the fresh set, so it
             -- is NULL (-> -1 below) when nothing was recomputed, never a spurious 0.
             round(100.0 * count(*) FILTER (WHERE elig.confidence IN ('HIGH','MEDIUM')
                                              AND elig.computed_at >= (now() - '24 hours'::interval))::numeric
                   / NULLIF(count(*) FILTER (WHERE elig.computed_at >= (now() - '24 hours'::interval)), 0)::numeric, 1)
               AS high_med_fresh24h_pct
      FROM elig GROUP BY elig.collection_id
    ),
    want(metric, collection_id) AS (
      VALUES ('topshot_fmv_pct_stale_30d', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_pct_stale_30d',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_pct_stale_30d', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_pct_stale_30d',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_pct_stale_30d',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    want_share(metric, collection_id) AS (
      VALUES ('topshot_fmv_high_med_share_pct', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_high_med_share_pct',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_high_med_share_pct', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_high_med_share_pct',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_high_med_share_pct',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    want_sweep(metric, collection_id) AS (
      VALUES ('topshot_fmv_sweep_pct_24h', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_sweep_pct_24h',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_sweep_pct_24h', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_sweep_pct_24h',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_sweep_pct_24h',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    want_fresh(metric, collection_id) AS (
      VALUES ('topshot_fmv_high_med_fresh24h_pct', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_high_med_fresh24h_pct',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_high_med_fresh24h_pct', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_high_med_fresh24h_pct',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_high_med_fresh24h_pct',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    resolved AS (
      SELECT w.metric, COALESCE(a.pct_stale_30d, 0::numeric) AS value
      FROM want w LEFT JOIN agg a ON a.collection_id = w.collection_id
      UNION ALL
      SELECT w.metric, COALESCE(a.high_med_pct, 0::numeric) AS value
      FROM want_share w LEFT JOIN agg a ON a.collection_id = w.collection_id
      UNION ALL
      -- -1, not 0: an absent collection has no denominator, and 0% would be a claim.
      SELECT w.metric, COALESCE(a.sweep_pct_24h, -1::numeric) AS value
      FROM want_sweep w LEFT JOIN agg a ON a.collection_id = w.collection_id
      UNION ALL
      SELECT w.metric, COALESCE(a.high_med_fresh24h_pct, -1::numeric) AS value
      FROM want_fresh w LEFT JOIN agg a ON a.collection_id = w.collection_id
    )
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT r.metric, r.value, now(),
           round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM resolved r
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- The new families are listed here too. Omitting them would leave them holding a
    -- PREVIOUS value while their siblings read 999 -- a half-failed leg that looks
    -- partly healthy, which is the shape that makes an outage unmeasurable.
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['topshot_fmv_pct_stale_30d','allday_fmv_pct_stale_30d','golazos_fmv_pct_stale_30d',
                      'ufc_fmv_pct_stale_30d','candy_fmv_pct_stale_30d',
                      'topshot_fmv_high_med_share_pct','allday_fmv_high_med_share_pct','golazos_fmv_high_med_share_pct',
                      'ufc_fmv_high_med_share_pct','candy_fmv_high_med_share_pct',
                      'topshot_fmv_sweep_pct_24h','allday_fmv_sweep_pct_24h','golazos_fmv_sweep_pct_24h',
                      'ufc_fmv_sweep_pct_24h','candy_fmv_sweep_pct_24h',
                      'topshot_fmv_high_med_fresh24h_pct','allday_fmv_high_med_fresh24h_pct',
                      'golazos_fmv_high_med_fresh24h_pct','ufc_fmv_high_med_fresh24h_pct',
                      'candy_fmv_high_med_fresh24h_pct']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_fmv_sanity()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '180s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT count(*)::numeric INTO v FROM public.v_fmv_sanity_flags;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('fmv_sanity_flags', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('fmv_sanity_flags', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_impossible_parallel()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '480s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT count(*)::numeric INTO v
    FROM public.editions e
    JOIN public.sales s ON s.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND e.external_id::text ~ '::'::text
      AND e.circulation_count > 0
      AND s.serial_number > e.circulation_count;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_pack_ev()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '120s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT COALESCE(
             round(100.0 * (1.0
               - (SELECT count(*) FROM public.pack_ev_latest)::numeric
                 / NULLIF((SELECT count(DISTINCT h.pack_listing_id) FROM public.pack_ev_history h), 0)::numeric
             ), 2), 999)
      INTO v;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pack_ev_publish_shortfall_pct', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pack_ev_publish_shortfall_pct', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_panini()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '60s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v_short numeric; v_dry numeric;
BEGIN
  BEGIN
    WITH src AS (
      SELECT v.capture_day, v.column_last_sale_usd, v.mapping_shortfall
      FROM public.v_panini_serial_sale_field_supply v
    ),
    runs AS (
      SELECT bool_or(s.column_last_sale_usd > 0) OVER (
               ORDER BY s.capture_day DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS seen_supply
      FROM src s
    )
    SELECT COALESCE(max(s2.mapping_shortfall), 0)::numeric,
           (SELECT count(*) FROM runs r WHERE NOT r.seen_supply)::numeric
      INTO v_short, v_dry
    FROM src s2;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('panini_sale_field_mapping_shortfall', v_short, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)),
           ('panini_sale_price_capture_dry_days', COALESCE(v_dry, 0), now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['panini_sale_field_mapping_shortfall','panini_sale_price_capture_dry_days']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_pinnacle_fmv_share()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '90s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    WITH latest AS (
      SELECT DISTINCT ON (render_id) render_id, fmv_confidence
      FROM public.pinnacle_fmv_history
      ORDER BY render_id, computed_at DESC
    )
    SELECT round(100.0 * count(*) FILTER (WHERE fmv_confidence IN ('HIGH','MEDIUM'))::numeric
                 / NULLIF(count(*), 0)::numeric, 1)
      INTO v FROM latest;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pinnacle_fmv_high_med_share_pct', COALESCE(v, 0), now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pinnacle_fmv_high_med_share_pct', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rpc_thp_leg_serial_supply()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '180s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT COALESCE(max(q.pct), 0)::numeric INTO v
    FROM (
      SELECT (100.0 * count(*) FILTER (WHERE COALESCE(s.serial_number, 0) = 0)) / count(*) AS pct
        FROM public.sales s
       WHERE s.sold_at >= now() - '30 days'::interval
         AND s.ingested_at >= now() - '10 days'::interval
         AND s.ingested_at <  now() - '3 days'::interval
         AND s.nft_id IS NOT NULL
         AND s.nft_id <> ''
       GROUP BY s.collection
      HAVING count(*) >= 200
    ) q;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('sales_serial_supply_worst_pct', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('sales_serial_supply_worst_pct', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.run_topshot_onchain_rekey()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_res     jsonb;
  v_err     text;
BEGIN
  BEGIN
    v_res := public.remap_topshot_from_onchain_map();
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := SQLERRM;
    v_res := NULL;
  END;

  -- ⚠ rows_found stays NULL: this function has no candidate count of its own, and
  -- a 0 there would read as "nothing to do" rather than "not measured". Same rule
  -- for the write counters on the error path — NULL, never 0.
  PERFORM public.log_pipeline_run(
    'topshot-onchain-rekey',
    v_started,
    NULL,
    CASE WHEN v_err IS NULL
         THEN COALESCE((v_res->>'sales_rekeyed')::int, 0)
            + COALESCE((v_res->>'moments_rekeyed')::int, 0)
    END,
    CASE WHEN v_err IS NULL THEN (v_res->>'moments_deferred_conflict')::int END,
    v_err IS NULL,
    v_err,
    'nba_top_shot',
    NULL,
    NULL,
    jsonb_build_object('remap', v_res, 'rekey_error', v_err)
  );

  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', v_err);
  END IF;
  RETURN COALESCE(v_res, '{}'::jsonb) || jsonb_build_object('ok', true);
END
$fn$;

DO $$
DECLARE v_bad text; v_expected jsonb := '{
  "refresh_allday_badge_low_ask": "559399212761a2d822a6e41e482f6ba9",
  "refresh_atlas_pack_ev": "0825388b3ce854384f2229c3e39c4b21",
  "refresh_golazos_badge_low_ask": "db98e8cba5d7e0d25e7c3dbdbd3a107b",
  "refresh_insights_new_collectors": "2d51349cf53c6511192c6e20ac030715",
  "refresh_topshot_special_serial_owners_mv": "b67bb90d509e3b5b88605c1c2cf973b0",
  "rpc_thp_leg_board_liveness": "2f89795f1e8547a5290cc9588bda6bee",
  "rpc_thp_leg_fmv_coverage": "be182ee1c144203e293e386c23d4a9a7",
  "rpc_thp_leg_fmv_sanity": "6d1e9891c3a409242fb38eae0d1a808b",
  "rpc_thp_leg_impossible_parallel": "61c992fc4e48a197814431c10136936f",
  "rpc_thp_leg_pack_ev": "d84a8496b0b5251b6bd87d68467690aa",
  "rpc_thp_leg_panini": "f7338af95dca55e8877ebca75b5f6c19",
  "rpc_thp_leg_pinnacle_fmv_share": "9e15031dbe63ecfa9ffd9289c051aa8c",
  "rpc_thp_leg_serial_supply": "131ade53b2e7cc75e92de1b303802f48",
  "run_topshot_onchain_rekey": "e944f8c1a31d770d1022b224fde15d06"
}'::jsonb; r record;
BEGIN
  FOR r IN SELECT p.proname, md5(p.prosrc) AS m FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname IN (SELECT jsonb_object_keys(v_expected)) LOOP
    IF r.m <> (v_expected ->> r.proname) THEN
      RAISE EXCEPTION 'R118: % body after apply is not the expected rewrite (md5 % vs %)', r.proname, r.m, v_expected ->> r.proname;
    END IF;
  END LOOP;
  SELECT string_agg(p.proname, ', ') INTO v_bad FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN (SELECT jsonb_object_keys(v_expected))
     AND (p.prosrc ~* 'EXCEPTION\s+WHEN\s+OTHERS\s+THEN' OR p.prosrc !~ 'WHEN query_canceled OR OTHERS');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'R118: still blind to query_canceled: %', v_bad; END IF;
  IF has_function_privilege('anon', 'public.rpc_thp_leg_impossible_parallel()', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked'; END IF;
END $$;
