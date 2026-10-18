-- Panini WC Hobby pack: a SIMULATED median pack and P(pull >= price), refreshed hourly.
--
-- WHY (2026-10-18 ~9:40 AM PT, Claude Code cloud; panini.md Next 4): the board's EV is a MEAN that a
-- handful of chase cards carry (10-18: Hobby mean $138 vs a $135 floor, while the median pack is
-- ~$18 and only ~13 % of packs pull at least the price). Its "typical pull" sums family medians,
-- which is not a median pack. The house gate is "no +EV copy unless P(profit) >= 50 %", and the
-- board could not state P(profit) at all.
--
-- WHAT:
--   * public.panini_pack_ev_sim (pack_id PK): sims, mean, median, P(pull >= cost), the cost it was
--     judged against, computed_at, ok, error. RLS on; anon/authenticated have no access (the route
--     reads it as service_role through the board).
--   * public.refresh_panini_pack_ev_sim(p_sims): Monte Carlo over the SAME model as
--     panini_pack_ev_model v0.5 for Hobby (1038): 2 Silver + 1 base parallel + (base parallel 0.65 /
--     insert 0.35), each slot drawn from that family's priced editions weighted by still_in_packs
--     (width_bucket over cumulative weights). Positive control at build: 20,000 packs gave mean
--     $137.30 vs the board's $138, median $18.00, P(beat $135) 13.2 %.
--     FOTL (1039) is not simulated: its exclusive leg is withheld (20261018155404).
--     A failed run writes ok=false + error (WHEN query_canceled OR OTHERS; the tail is one upsert +
--     one log row) and logs pipeline 'panini-pack-ev-sim'; `ok` is derived from whether the row landed.
--   * pg_cron 'rpc-panini-pack-ev-sim' hourly at :58 (the least-loaded minute on 10-18).
--   * panini_pack_ev_board gains FOUR appended columns (sim_median_pull_usd, sim_p_beat_cost,
--     sim_cost_usd, sim_computed_at): NULL unless the sim row is ok, < 3 h old, and the pack is not
--     withheld. Every existing column is unchanged in name and order.
-- anon-exec: revoked (refresh_panini_pack_ev_sim) — new function; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- REVERT: SELECT cron.unschedule('rpc-panini-pack-ev-sim'); re-apply the board body of 20261018155404;
--   DROP FUNCTION public.refresh_panini_pack_ev_sim(integer); DROP TABLE public.panini_pack_ev_sim;

CREATE TABLE IF NOT EXISTS public.panini_pack_ev_sim (
  pack_id         text PRIMARY KEY,
  sims            integer NOT NULL,
  mean_pull_usd   numeric,
  median_pull_usd numeric,
  p_beat_cost     numeric,
  cost_usd        numeric,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  ok              boolean NOT NULL,
  error           text
);
ALTER TABLE public.panini_pack_ev_sim ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_pack_ev_sim FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.panini_pack_ev_sim TO service_role;

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
                       'cost_usd', v_cost, 'rows_written', v_written));
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

REVOKE EXECUTE ON FUNCTION public.refresh_panini_pack_ev_sim(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_pack_ev_sim(integer) TO service_role;

CREATE OR REPLACE VIEW public.panini_pack_ev_board AS
 SELECT p.id,
    p.collection_id,
    p.pack_type,
    COALESCE(p.floor_usd, p.avg_sale_usd) AS pack_cost_usd,
    p.floor_usd,
    p.avg_sale_usd,
    p.recent_sale_usd,
    p.cards_per_pack,
    p.packs_total,
    p.packs_remaining,
        CASE
            WHEN COALESCE(p.packs_total, 0) > 0 THEN round((p.packs_total - COALESCE(p.packs_remaining, p.packs_total))::numeric / p.packs_total::numeric * 100::numeric, 1)
            ELSE NULL::numeric
        END AS packs_ripped_pct,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 THEN
            CASE
                WHEN p.pack_type = 'fotl'::text THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END
            WHEN p.model_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled THEN s.fotl_actual_ev
            WHEN p.model_set_id = 2420 AND p.pack_type IS DISTINCT FROM 'fotl'::text AND s.hobby_modeled THEN s.hobby_actual_ev
            WHEN p.model_set_id IS NULL AND g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval) THEN g.actual_ev_usd
            ELSE NULL::numeric
        END AS actual_ev_usd,
        CASE
            WHEN fw.withheld THEN NULL::double precision
            WHEN p.model_set_id = 2332 THEN
            CASE
                WHEN p.pack_type = 'fotl'::text THEN m.fotl_typical_ev
                ELSE m.hobby_typical_ev
            END
            WHEN p.model_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled THEN s.fotl_typical_ev::double precision
            WHEN p.model_set_id = 2420 AND p.pack_type IS DISTINCT FROM 'fotl'::text AND s.hobby_modeled THEN s.hobby_typical_ev::double precision
            WHEN p.model_set_id IS NULL AND g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval) THEN g.typical_ev_usd::double precision
            ELSE NULL::double precision
        END AS typical_ev_usd,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 THEN m.silver_ev
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.silver_ev
            ELSE NULL::numeric
        END AS silver_ev,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 THEN m.base_parallel_ev
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.base_parallel_ev
            ELSE NULL::numeric
        END AS base_parallel_ev,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 THEN m.insert_ev
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.insert_ev
            ELSE NULL::numeric
        END AS insert_ev,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 AND p.pack_type = 'fotl'::text THEN m.fotl_exclusive_ev
            WHEN p.model_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled THEN s.fotl_exclusive_ev
            ELSE NULL::numeric
        END AS fotl_exclusive_ev,
        CASE
            WHEN fw.withheld THEN (((('not modeled · only '::text || COALESCE(m.fotl_remain_indexed, 0::bigint)) || ' of the '::text) || p.packs_remaining) || ' FOTL-exclusive cards still in these packs are indexed — Panini shows a card only once it has been listed for sale, so the exclusive slot would be priced from an unrepresentative part of its supply; EV is withheld, not zero'::text)
            WHEN p.model_set_id = 2332 THEN m.model_note
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.model_note
            WHEN p.model_set_id = 2420 THEN 'not modeled yet · the sales model for this product needs >=10 sales in every card family of this pack and a fit under 6 hours old; EV is withheld, not zero'::text
            WHEN g.model_note IS NOT NULL AND g.computed_at <= (now() - '06:00:00'::interval) THEN 'not modeled · the guaranteed-contents model has not refreshed in 6 hours; EV is withheld, not zero'::text
            WHEN g.model_note IS NOT NULL THEN g.model_note
            WHEN p.product_set_id = ANY (ARRAY[2332, 2420]) THEN 'not modeled · the EV model covers this product''s standard Hobby and FOTL packs only; this pack''s contents and odds differ; EV is withheld, not zero'::text
            ELSE 'not modeled · no pack-EV model exists for this product yet (card prices for it are not collected); EV is withheld, not zero'::text
        END AS model_note,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 AND COALESCE(p.floor_usd, p.avg_sale_usd) > 0::numeric THEN round(
            CASE
                WHEN p.pack_type = 'fotl'::text THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd))
            WHEN p.model_set_id = 2420 AND COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd) > 0::numeric AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN round(
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_actual_ev
                ELSE s.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd))
            WHEN p.model_set_id IS NULL AND g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval) AND COALESCE(p.floor_usd, p.avg_sale_usd) > 0::numeric THEN round(g.actual_ev_usd - COALESCE(p.floor_usd, p.avg_sale_usd))
            ELSE NULL::numeric
        END AS net_rip_edge_usd,
    p.updated_at,
    p.product_name,
    p.sport,
    p.product_set_id,
    NOT fw.withheld AND ((p.model_set_id = 2332) IS TRUE OR p.model_set_id = 2420 AND
        CASE
            WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
            ELSE s.hobby_modeled
        END IS TRUE OR p.model_set_id IS NULL AND g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval)) AS ev_modeled,
        CASE WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) THEN ps.median_pull_usd ELSE NULL::numeric END AS sim_median_pull_usd,
        CASE WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) THEN ps.p_beat_cost ELSE NULL::numeric END AS sim_p_beat_cost,
        CASE WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) THEN ps.cost_usd ELSE NULL::numeric END AS sim_cost_usd,
        CASE WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) THEN ps.computed_at ELSE NULL::timestamp with time zone END AS sim_computed_at
   FROM ( SELECT ps_1.id,
            ps_1.collection_id,
            ps_1.pack_type,
            ps_1.price_usd,
            ps_1.cards_per_pack,
            ps_1.packs_total,
            ps_1.packs_remaining,
            ps_1.gross_ev_usd,
            ps_1.net_ev_usd,
            ps_1.updated_at,
            ps_1.floor_usd,
            ps_1.avg_sale_usd,
            ps_1.recent_sale_usd,
            ps_1.top_sale_usd,
            ps_1.raw,
            ps_1.product_name,
            ps_1.sport,
            ps_1.product_set_id,
            ps_1.page_url,
                CASE
                    WHEN ps_1.product_set_id = 2332 AND (ps_1.id = ANY (ARRAY['1038'::text, '1039'::text])) THEN 2332
                    WHEN ps_1.product_set_id = 2420 AND (ps_1.id = ANY (ARRAY['1055'::text, '1056'::text])) THEN 2420
                    ELSE NULL::integer
                END AS model_set_id
           FROM panini_pack_state ps_1) p
     CROSS JOIN panini_pack_ev_model m
     -- The FOTL coverage gate (2026-10-18). FALSE whenever it does not apply; an unknown packs_remaining
     -- or exclusive count withholds (unknown coverage is not coverage).
     CROSS JOIN LATERAL ( SELECT p.model_set_id IS NOT DISTINCT FROM 2332 AND p.pack_type = 'fotl'::text
            AND NOT COALESCE(m.fotl_remain_indexed::numeric >= 0.9 * p.packs_remaining::numeric, false) AS withheld) fw
     LEFT JOIN panini_pack_ev_model_wnba_2026_sales s ON s.product_set_id = p.model_set_id
     LEFT JOIN mv_panini_pack_ev_guaranteed g ON g.pack_id = p.id AND p.model_set_id IS NULL
     LEFT JOIN panini_pack_ev_sim ps ON ps.pack_id = p.id;

ALTER VIEW public.panini_pack_ev_board SET (security_invoker = on);

SELECT public.refresh_panini_pack_ev_sim();
SELECT cron.schedule('rpc-panini-pack-ev-sim', '58 * * * *', $cron$SELECT public.refresh_panini_pack_ev_sim()$cron$);
