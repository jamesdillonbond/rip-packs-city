-- anon-exec: intentional — snapshot re-create with the SAME signature preserves the revoked ACL; verified post-apply: anon EXECUTE false (serial_fmv_estimate)
-- anon-exec: intentional — snapshot re-create with the SAME signature preserves the revoked ACL; verified post-apply: anon EXECUTE false (serial_fmv_estimate_uncalibrated)
-- anon-exec: intentional — snapshot re-create with the SAME signature preserves the revoked ACL; verified post-apply: anon EXECUTE false (sync_topshot_pools_from_atlas)
-- 2026-11-25: RECORD-ONLY re-issue, no behaviour change. Three functions changed today by a RENAME
-- (20261125154657: serial_fmv_estimate -> serial_fmv_estimate_uncalibrated + a new calibrating wrapper) and by
-- two guarded text SPLICES (20261126011212, 20261126013404: sync_topshot_pools_from_atlas). Neither form is a
-- CREATE OR REPLACE block, so no DB-invariant pin could name a migration carrying the live body. This file
-- re-issues each live body verbatim (prosrc md5 checked against production before writing:
-- serial_fmv_estimate 6bd516ecf743f80a85552fc22f985146, serial_fmv_estimate_uncalibrated
-- 76e87b2c8c52dae7a4f5a54f63f4b44d, sync_topshot_pools_from_atlas e41bfdc4d07cac262d80c90911057adb).
-- CREATE OR REPLACE keeps owner and grants. The wrapper is written FIRST on purpose: the pin extractor matches
-- the prefix "CREATE OR REPLACE FUNCTION public.serial_fmv_estimate", which the _uncalibrated name also starts with.

CREATE OR REPLACE FUNCTION public.serial_fmv_estimate(p_collection_id uuid, p_serial integer, p_circulation integer,
  p_tier text, p_edition_fmv numeric, p_confidence text, p_jersey_number integer, p_edition_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE r jsonb; v_f numeric; v_est numeric;
BEGIN
  r := public.serial_fmv_estimate_uncalibrated(p_collection_id, p_serial, p_circulation, p_tier,
         p_edition_fmv, p_confidence, p_jersey_number, p_edition_id);
  IF r IS NULL OR (r->>'estimate_usd') IS NULL THEN RETURN r; END IF;
  SELECT c.factor INTO v_f FROM public.serial_fmv_calibration c
   WHERE c.collection_id = p_collection_id AND c.serial_bucket = r->>'serial_bucket';
  IF v_f IS NULL OR v_f <= 0 OR v_f = 1 THEN RETURN r; END IF;
  v_est := GREATEST(p_edition_fmv, (r->>'estimate_usd')::numeric / v_f);
  RETURN r || jsonb_build_object('estimate_usd', round(v_est, 2),
     'multiplier', round(v_est / p_edition_fmv, 2),
     'uncalibrated_estimate_usd', (r->>'estimate_usd')::numeric,
     'calibration_factor', round(v_f, 3), 'calibration', 'serial-cal-1.0');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.serial_fmv_estimate_uncalibrated(
  p_collection_id uuid, p_serial integer, p_circulation integer, p_tier text,
  p_edition_fmv numeric, p_confidence text, p_jersey_number integer, p_edition_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bucket text; v_band text; v_mult numeric; v_sample integer; v_basis text; v_estimate numeric;
  v_k numeric; v_beta numeric; v_r numeric; v_fmin numeric; v_fmax numeric; v_model_tier text; v_fmv_clamped numeric;
  v_label text; v_lowconf boolean := false;
  v_pm public.serial_fmv_pooled_model%ROWTYPE;
  v_set_id uuid; v_player_id uuid; v_jersey integer;
  v_set_eff numeric; v_set_sup integer; v_pl_eff numeric; v_pl_sup integer; v_ln numeric; v_tier text;
  v_js1 boolean := false;
BEGIN
  IF p_serial IS NULL OR p_circulation IS NULL OR p_circulation <= 0
     OR p_edition_fmv IS NULL OR p_edition_fmv <= 0 THEN RETURN NULL; END IF;
  IF upper(coalesce(p_confidence,'')) NOT IN ('HIGH','MEDIUM') THEN RETURN NULL; END IF;
  IF p_serial = 1 THEN v_bucket := 'first';
  ELSIF p_serial = p_circulation THEN v_bucket := 'perfect';
  ELSIF p_jersey_number IS NOT NULL AND p_jersey_number > 1 AND p_serial = p_jersey_number THEN v_bucket := 'jersey';
  ELSE RETURN NULL; END IF;
  v_band := CASE WHEN p_circulation<100 THEN 'ultra' WHEN p_circulation<500 THEN 'low'
                 WHEN p_circulation<2500 THEN 'mid' WHEN p_circulation<10000 THEN 'high' ELSE 'mass' END;
  v_label := CASE v_bucket WHEN 'first' THEN 'estimated #1 premium'
                           WHEN 'perfect' THEN 'estimated perfect-mint premium'
                           ELSE 'estimated jersey-match premium' END;
  v_tier := upper(coalesce(p_tier,''));

  IF p_edition_id IS NOT NULL AND v_bucket IN ('first','perfect') THEN
    SELECT * INTO v_pm FROM public.serial_fmv_pooled_model WHERE collection_id = p_collection_id AND is_active LIMIT 1;
    IF FOUND THEN
      SELECT e.set_id, e.player_id, e.jersey_number INTO v_set_id, v_player_id, v_jersey
        FROM public.editions e WHERE e.id = p_edition_id;
      SELECT effect, support_n INTO v_set_eff, v_set_sup FROM public.serial_fmv_pooled_set_effect
        WHERE collection_id = p_collection_id AND set_id = v_set_id;
      SELECT effect, support_n INTO v_pl_eff, v_pl_sup FROM public.serial_fmv_pooled_player_effect
        WHERE collection_id = p_collection_id AND player_id = v_player_id;
      IF (coalesce(v_set_sup,0) >= v_pm.gate_min_support OR coalesce(v_pl_sup,0) >= v_pm.gate_min_support) THEN
        v_fmv_clamped := LEAST(GREATEST(p_edition_fmv, v_pm.fmv_min), v_pm.fmv_max);
        v_ln := v_pm.intercept + v_pm.b_log_fmv * ln(v_fmv_clamped) + v_pm.b_log_circ * ln(GREATEST(p_circulation,1))
              + CASE v_tier WHEN 'RARE' THEN v_pm.tier_rare WHEN 'LEGENDARY' THEN v_pm.tier_legendary
                            WHEN 'FANDOM' THEN v_pm.tier_fandom ELSE 0 END;
        IF v_bucket = 'perfect' THEN
          v_ln := v_ln + v_pm.bucket_perfect
                + CASE v_tier WHEN 'RARE' THEN v_pm.px_rare WHEN 'LEGENDARY' THEN v_pm.px_legendary
                              WHEN 'FANDOM' THEN v_pm.px_fandom ELSE 0 END;
        END IF;
        v_ln := v_ln + coalesce(v_set_eff,0) + coalesce(v_pl_eff,0);
        -- double-special: #1 serial of a player whose jersey is also 1 (validated ~x1.38 premium)
        IF v_bucket = 'first' AND v_jersey = 1 THEN
          v_ln := v_ln + v_pm.jersey1;
          v_js1 := true;
        END IF;
        v_estimate := GREATEST(p_edition_fmv, p_edition_fmv * exp(v_ln));
        v_estimate := LEAST(GREATEST(v_estimate, p_edition_fmv * v_pm.prem_lo), p_edition_fmv * v_pm.prem_hi);
        RETURN jsonb_build_object('estimate_usd', round(v_estimate,2), 'multiplier', round(v_estimate/p_edition_fmv,2),
          'serial_bucket', v_bucket, 'circ_band', v_band, 'basis', 'pooled_model',
          'set_support', coalesce(v_set_sup,0), 'player_support', coalesce(v_pl_sup,0),
          'jersey1_match', v_js1,
          'model_beta', round(v_pm.b_log_fmv,4), 'algo_version', v_pm.algo_version, 'label', v_label);
      END IF;
    END IF;
  END IF;

  IF v_bucket = 'jersey' THEN
    SELECT k,beta,r,fmv_min,fmv_max INTO v_k,v_beta,v_r,v_fmin,v_fmax
    FROM public.serial_fmv_jersey_model WHERE collection_id=p_collection_id AND is_reliable AND tier=coalesce(p_tier,'UNKNOWN') LIMIT 1;
    IF v_k IS NULL THEN
      SELECT k,beta,r,fmv_min,fmv_max INTO v_k,v_beta,v_r,v_fmin,v_fmax
      FROM public.serial_fmv_jersey_model WHERE collection_id=p_collection_id AND is_reliable AND tier='ALL' LIMIT 1;
    END IF;
    IF v_k IS NULL THEN RETURN NULL; END IF;
    v_fmv_clamped := LEAST(GREATEST(p_edition_fmv,coalesce(v_fmin,p_edition_fmv)),coalesce(v_fmax,p_edition_fmv));
    v_estimate := GREATEST(p_edition_fmv, v_k*power(v_fmv_clamped,v_beta));
    v_lowconf := (p_edition_fmv > coalesce(v_fmax, p_edition_fmv)) OR (v_estimate <= p_edition_fmv*1.05);
    RETURN jsonb_build_object('estimate_usd',round(v_estimate,2),'multiplier',round(v_estimate/p_edition_fmv,2),
      'serial_bucket','jersey','circ_band',v_band,'basis','power_model','sample_size',NULL,
      'model_k',round(v_k,4),'model_beta',round(v_beta,4),'model_r',round(v_r,3),'low_confidence',v_lowconf,'label',v_label);
  END IF;

  v_model_tier := CASE WHEN v_bucket = 'perfect' THEN 'ALL' ELSE coalesce(p_tier,'UNKNOWN') END;
  SELECT pm.k,pm.beta,pm.r,pm.fmv_min,pm.fmv_max INTO v_k,v_beta,v_r,v_fmin,v_fmax
  FROM public.serial_fmv_power_model pm
  WHERE pm.collection_id=p_collection_id AND pm.serial_bucket=v_bucket AND pm.tier=v_model_tier AND pm.is_reliable LIMIT 1;
  IF v_k IS NOT NULL THEN
    v_fmv_clamped := LEAST(GREATEST(p_edition_fmv,coalesce(v_fmin,p_edition_fmv)),coalesce(v_fmax,p_edition_fmv));
    v_estimate := GREATEST(p_edition_fmv, v_k*power(v_fmv_clamped,v_beta));
    RETURN jsonb_build_object('estimate_usd',round(v_estimate,2),'multiplier',round(v_estimate/p_edition_fmv,2),
      'serial_bucket',v_bucket,'circ_band',v_band,'basis','power_model','sample_size',NULL,
      'model_k',round(v_k,4),'model_beta',round(v_beta,4),'model_r',round(v_r,3),'label',v_label);
  END IF;

  SELECT m.multiplier,m.sample_size INTO v_mult,v_sample
  FROM public.serial_fmv_multipliers m
  WHERE m.collection_id=p_collection_id AND m.serial_bucket=v_bucket AND m.tier=coalesce(p_tier,'UNKNOWN') AND m.circ_band=v_band AND m.is_reliable LIMIT 1;
  IF v_mult IS NOT NULL THEN v_basis:='tier_circ';
  ELSE
    SELECT m.multiplier,m.sample_size INTO v_mult,v_sample
    FROM public.serial_fmv_multipliers m
    WHERE m.collection_id=p_collection_id AND m.serial_bucket=v_bucket AND m.tier='ALL' AND m.circ_band='ALL' AND m.is_reliable LIMIT 1;
    v_basis:='aggregate';
  END IF;
  IF v_mult IS NULL THEN RETURN NULL; END IF;
  v_estimate := GREATEST(p_edition_fmv, p_edition_fmv*v_mult);
  RETURN jsonb_build_object('estimate_usd',round(v_estimate,2),'multiplier',round(v_mult,2),
    'serial_bucket',v_bucket,'circ_band',v_band,'basis',v_basis,'sample_size',v_sample,'label',v_label);
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_topshot_pools_from_atlas(p_limit integer DEFAULT 400)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_cid      constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_cands    int := 0;
  v_filled   int := 0;
  v_upgraded int := 0;
  v_skipped  int := 0;
  v_rows     int := 0;
  v_zeroed   int := 0;
  v_err      text;
BEGIN
  BEGIN
    -- ONE statement (no temp tables): the write and the zeroing touch disjoint rows by construction
    WITH sub AS (
      -- parallel name -> subedition id (Rippled -> 4, Vortex -> 3, ...)
      SELECT lower(subedition_name) AS nm, min(subedition_id) AS sid
        FROM public.v_topshot_parallel_premiums
       WHERE subedition_name IS NOT NULL AND subedition_id IS NOT NULL
       GROUP BY 1
    ), pool AS (
      SELECT dist_id, count(*) FILTER (WHERE drop_weight > 0) AS n_live, bool_and(pool_source IN ('gql', 'gql_historical')) AS all_gql,
             bool_and(pool_source = 'atlas') AS all_atlas, max(last_refreshed_at) AS refreshed
        FROM public.pack_drop_pool WHERE collection_id = v_cid GROUP BY dist_id
    ), lp0 AS (
      SELECT dist_id, max(pass) AS p, max(fetched_at) AS f FROM public.topshot_atlas_dist_editions GROUP BY dist_id
    ), lp AS (
      -- 2026-11-16: an edition list is CURRENT, not only recently fetched, when a later summary
      -- carried that same reconciled pass forward (topshot_pack_supply_tick re-reads an unchanged
      -- drop's summary every 40 h without re-fetching its pages). 11 listed packs (WNBA Base Set
      -- R1/R5, Run It Back: Origins, Two Moment Common Pack, ...) had no pool because their pages
      -- were fetched > 7 days ago. The 7-day gate reads `fresh`; the 'refresh' test keeps `f`, so
      -- an unchanged Atlas pool is not rewritten every 40 h.
      SELECT lp0.dist_id, lp0.p, lp0.f,
             CASE WHEN t.editions_pass = lp0.p AND t.editions_done_at IS NOT NULL
                       AND t.edition_remaining_sum IS NOT DISTINCT FROM t.remaining_total
                  THEN greatest(lp0.f, t.summary_fetched_at) ELSE lp0.f END AS fresh
        FROM lp0 LEFT JOIN public.topshot_atlas_dists t ON t.dist_id = lp0.dist_id
    ), cand AS (
      -- a catalogued dist with a fresh Atlas edition list and EITHER no pool at all and a live
      -- secondary ask or a first sighting in the last 7 days ('fill'), OR a pool written only by the GraphQL lane, dormant since
      -- 2026-08-28 and truncated at its 40-row page cap on 433 of 767 dists ('upgrade'), OR an
      -- Atlas pool whose edition list has been re-fetched since it was written ('refresh')
      SELECT lp.dist_id, lp.p,
             CASE WHEN pool.dist_id IS NULL THEN 'fill' WHEN pool.all_gql THEN 'upgrade' ELSE 'refresh' END AS kind,
             CASE WHEN pool.all_gql THEN pool.n_live ELSE 0 END AS prior_n
        FROM lp
        JOIN public.pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = lp.dist_id
        LEFT JOIN pool ON pool.dist_id = lp.dist_id
       WHERE lp.fresh > now() - interval '7 days'
         AND ((pool.dist_id IS NULL
               AND (EXISTS (SELECT 1 FROM public.pack_ask_state pas
                             WHERE pas.collection_slug = 'nba-top-shot' AND pas.dist_id = lp.dist_id
                               AND pas.is_listed IS TRUE AND pas.lowest_ask > 0)
                    -- 2026-11-13: a NEW dist (on primary sale, nothing listed yet) fills too, so its
                    -- EV exists while it is on sale; topshot_atlas_seed_new_dists feeds its editions
                    OR pd.first_seen_at > now() - interval '7 days'))
              OR pool.all_gql
              OR (pool.all_atlas AND lp.f > pool.refreshed))
       ORDER BY (pool.dist_id IS NULL) DESC, coalesce(pool.all_atlas AND lp.f > pool.refreshed, false) DESC, coalesce(pool.all_gql, false) DESC, lp.f DESC, lp.dist_id
       LIMIT greatest(coalesce(p_limit, 400), 1)
    ), arows AS (
      -- the latest Atlas pass of each candidate, mapped to our editions (base, or base::<subedition>)
      SELECT c.dist_id, c.kind, c.prior_n, e.id AS edition_id, e.external_id AS ext,
             greatest(coalesce(a.remaining_count, 0), 0)::numeric AS rem,
             greatest(coalesce(a.original_count, 0), 0)::numeric AS orig
        FROM cand c
        JOIN public.topshot_atlas_dist_editions a ON a.dist_id = c.dist_id AND a.pass = c.p
        LEFT JOIN sub s ON s.nm = lower(a.parallel)
        LEFT JOIN public.editions e ON e.collection_id = v_cid
             AND e.external_id = CASE WHEN a.parallel = 'Standard' THEN a.set_id || ':' || a.play_id
                                      WHEN s.sid IS NOT NULL THEN a.set_id || ':' || a.play_id || '::' || s.sid END
    ), ok AS (
      -- gates: <= 5 % of the ORIGINAL pool unmapped, something left to draw, and at least as many
      -- editions as the pool it replaces still had DRAWABLE (weight > 0; Atlas lists only editions
      -- with remaining > 0, so a pool's drawn-out rows are not a shortfall). Anything else keeps
      -- what it has.
      SELECT dist_id, kind, sum(rem) FILTER (WHERE edition_id IS NOT NULL) AS rem_mapped
        FROM arows
       GROUP BY dist_id, kind, prior_n
      HAVING coalesce(sum(orig) FILTER (WHERE edition_id IS NULL), 0) <= 0.05 * nullif(sum(orig), 0)
         AND coalesce(sum(rem) FILTER (WHERE edition_id IS NOT NULL), 0) > 0
         AND count(DISTINCT edition_id) >= prior_n
    ), w AS (
      -- drop_weight = this edition's share of what is LEFT to draw (what a sealed pack holds
      -- today); orig_drop_weight = the original count, as the 07-17 Atlas writer stored it
      SELECT r.dist_id, r.edition_id, min(r.ext) AS ext, sum(r.rem) / o.rem_mapped AS wt, sum(r.orig) AS orig
        FROM arows r
        JOIN ok o ON o.dist_id = r.dist_id
       WHERE r.edition_id IS NOT NULL
       GROUP BY r.dist_id, r.edition_id, o.rem_mapped
    ), ins AS (
      INSERT INTO public.pack_drop_pool
             (collection_id, dist_id, edition_id, edition_flow_id, drop_weight, orig_drop_weight, slot_name, pool_source, last_refreshed_at)
      SELECT v_cid, w.dist_id, w.edition_id, w.ext, w.wt, w.orig, 'default', 'atlas', now() FROM w
      ON CONFLICT (collection_id, dist_id, edition_id, slot_name) DO UPDATE
         SET drop_weight = EXCLUDED.drop_weight,
             orig_drop_weight = EXCLUDED.orig_drop_weight,
             edition_flow_id = EXCLUDED.edition_flow_id,
             pool_source = 'atlas',
             last_refreshed_at = EXCLUDED.last_refreshed_at
      RETURNING 1
    ), upd AS (
      -- a re-written dist's rows that this pass of Atlas does not list are editions with nothing
      -- left to draw (Atlas lists only remaining > 0): they keep their row and their original
      -- count but carry no weight (never deleted; the dist is uniformly 'atlas' afterwards)
      UPDATE public.pack_drop_pool p
         SET drop_weight = 0, pool_source = 'atlas', last_refreshed_at = now()
        FROM ok o
       WHERE p.collection_id = v_cid AND p.dist_id = o.dist_id
         AND NOT EXISTS (SELECT 1 FROM w WHERE w.dist_id = p.dist_id AND w.edition_id = p.edition_id)
         AND (p.drop_weight <> 0 OR p.pool_source <> 'atlas')
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM cand),
           (SELECT count(*) FROM ok WHERE kind = 'fill'),
           (SELECT count(*) FROM ok WHERE kind <> 'fill'),
           (SELECT count(*) FROM ins),
           (SELECT count(*) FROM upd)
      INTO v_cands, v_filled, v_upgraded, v_rows, v_zeroed;
    v_skipped := v_cands - v_filled - v_upgraded;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
    v_filled := 0; v_upgraded := 0; v_rows := 0; v_zeroed := 0;
  END;

  PERFORM public.log_pipeline_run(
    'topshot-pool-from-atlas', v_started, v_cands, v_rows, v_skipped,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('candidates', v_cands, 'filled', v_filled, 'rewritten', v_upgraded, 'skipped', v_skipped,
                       'rows_written', v_rows, 'rows_zeroed', v_zeroed, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('ok', v_err IS NULL, 'candidates', v_cands, 'filled', v_filled, 'rewritten', v_upgraded,
                            'skipped', v_skipped, 'rows_written', v_rows, 'rows_zeroed', v_zeroed, 'error', v_err);
END
$function$;