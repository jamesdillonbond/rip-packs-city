-- audit_20261010_mv_panini_pack_ev_guaranteed_hourly
--
-- Cost fix for 20261010225911. panini_pack_ev_board read panini_pack_ev_guaranteed LIVE on every
-- /api/panini-pack-market cache miss (s-maxage 300): measured 107k buffers / 0.6 s per read, of which
-- ~49k was the guaranteed-contents arm (6,316 candidate-edition sales probes) — roughly double the
-- board's pre-10-10 cost, for figures built from 90-day sale medians that move slowly.
--
-- 1. mv_panini_pack_ev_guaranteed = panini_pack_ev_guaranteed + computed_at (the refresh time).
-- 2. refresh_panini_pack_ev_guaranteed(): REFRESH ... CONCURRENTLY (unique index on pack_id) and a
--    pipeline_runs row ('panini-pack-ev-guaranteed-mv': rows, modeled count, refresh_ms). pg_cron
--    rpc-panini-pack-ev-guaranteed hourly at :36, as postgres (the mv owner).
-- 3. panini_pack_ev_board joins the mv, and WITHHOLDS that arm's EV when the mv is older than 6 h
--    (the WNBA sales model's rule): a stopped refresh costs the EV, never shows a stale number as
--    current. The note says why.
-- 4. Cadence watch at info (silence > 150 min / no success > 300 min).
--
-- anon-exec: revoked (refresh_panini_pack_ev_guaranteed) — new function; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- REVERT: re-apply panini_pack_ev_board from 20261010225911; select cron.unschedule('rpc-panini-pack-ev-guaranteed');
--   delete the watchlist row; drop function public.refresh_panini_pack_ev_guaranteed(); drop materialized view public.mv_panini_pack_ev_guaranteed;

create materialized view public.mv_panini_pack_ev_guaranteed as
 SELECT g.pack_id,
    g.product_set_id,
    g.guaranteed_lines,
    g.lines_priced,
    g.ev_modeled,
    g.actual_ev_usd,
    g.typical_ev_usd,
    g.sales_n,
    g.model_note,
    now() AS computed_at
   FROM panini_pack_ev_guaranteed g;
create unique index mv_panini_pack_ev_guaranteed_pack_id on public.mv_panini_pack_ev_guaranteed (pack_id);
revoke all on public.mv_panini_pack_ev_guaranteed from public, anon, authenticated;
grant select on public.mv_panini_pack_ev_guaranteed to service_role;
comment on materialized view public.mv_panini_pack_ev_guaranteed is
  'panini_pack_ev_guaranteed materialised hourly (refresh_panini_pack_ev_guaranteed, pg_cron :36). computed_at = refresh time; panini_pack_ev_board withholds this arm''s EV past 6 h. 2026-10-10.';

create function public.refresh_panini_pack_ev_guaranteed()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
  v_modeled integer;
  v_ms      integer;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_pack_ev_guaranteed;
  SELECT count(*), count(*) FILTER (WHERE ev_modeled) INTO v_rows, v_modeled FROM public.mv_panini_pack_ev_guaranteed;
  v_ms := round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int;
  PERFORM public.log_pipeline_run(
    p_pipeline        := 'panini-pack-ev-guaranteed-mv',
    p_started_at      := v_started,
    p_rows_found      := v_rows,
    p_rows_written    := v_rows,
    p_rows_skipped    := 0,
    p_ok              := true,
    p_error           := NULL,
    p_collection_slug := 'panini_blockchain',
    p_cursor_before   := NULL,
    p_cursor_after    := NULL,
    p_extra           := jsonb_build_object('mv', 'mv_panini_pack_ev_guaranteed', 'packs_modeled', v_modeled, 'refresh_ms', v_ms));
  RETURN jsonb_build_object('ok', true, 'rows', v_rows, 'packs_modeled', v_modeled, 'refresh_ms', v_ms);
END;
$function$;
revoke all on function public.refresh_panini_pack_ev_guaranteed() from public, anon, authenticated;
grant execute on function public.refresh_panini_pack_ev_guaranteed() to postgres, service_role;
comment on function public.refresh_panini_pack_ev_guaranteed() is
  'Refreshes mv_panini_pack_ev_guaranteed (CONCURRENTLY) and logs pipeline panini-pack-ev-guaranteed-mv. pg_cron rpc-panini-pack-ev-guaranteed, hourly :36. 2026-10-10.';

insert into public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
values ('panini-pack-ev-guaranteed-mv', 150, 'info',
  'pg_cron rpc-panini-pack-ev-guaranteed (:36 hourly, postgres) -> refresh_panini_pack_ev_guaranteed(): materialises the guaranteed-contents pack EV behind panini_pack_ev_board (2026-10-10). The board withholds that EV once the mv is > 6 h old, so silence costs the EV, never a stale number.',
  true, 300)
on conflict (pipeline) do nothing;

select cron.schedule('rpc-panini-pack-ev-guaranteed', '36 * * * *', 'SELECT public.refresh_panini_pack_ev_guaranteed();');

create or replace view public.panini_pack_ev_board with (security_invoker = on) as
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
            WHEN (COALESCE(p.packs_total, 0) > 0) THEN round(((((p.packs_total - COALESCE(p.packs_remaining, p.packs_total)))::numeric / (p.packs_total)::numeric) * (100)::numeric), 1)
            ELSE NULL::numeric
        END AS packs_ripped_pct,
        CASE
            WHEN (p.model_set_id = 2332) THEN
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END
            WHEN ((p.model_set_id = 2420) AND (p.pack_type = 'fotl'::text) AND s.fotl_modeled) THEN s.fotl_actual_ev
            WHEN ((p.model_set_id = 2420) AND (p.pack_type IS DISTINCT FROM 'fotl'::text) AND s.hobby_modeled) THEN s.hobby_actual_ev
            WHEN ((p.model_set_id IS NULL) AND (g.ev_modeled IS TRUE) AND (g.computed_at > (now() - '06:00:00'::interval))) THEN g.actual_ev_usd
            ELSE NULL::numeric
        END AS actual_ev_usd,
        CASE
            WHEN (p.model_set_id = 2332) THEN
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_typical_ev
                ELSE m.hobby_typical_ev
            END
            WHEN ((p.model_set_id = 2420) AND (p.pack_type = 'fotl'::text) AND s.fotl_modeled) THEN (s.fotl_typical_ev)::double precision
            WHEN ((p.model_set_id = 2420) AND (p.pack_type IS DISTINCT FROM 'fotl'::text) AND s.hobby_modeled) THEN (s.hobby_typical_ev)::double precision
            WHEN ((p.model_set_id IS NULL) AND (g.ev_modeled IS TRUE) AND (g.computed_at > (now() - '06:00:00'::interval))) THEN (g.typical_ev_usd)::double precision
            ELSE NULL::double precision
        END AS typical_ev_usd,
        CASE
            WHEN (p.model_set_id = 2332) THEN m.silver_ev
            WHEN ((p.model_set_id = 2420) AND
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END) THEN s.silver_ev
            ELSE NULL::numeric
        END AS silver_ev,
        CASE
            WHEN (p.model_set_id = 2332) THEN m.base_parallel_ev
            WHEN ((p.model_set_id = 2420) AND
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END) THEN s.base_parallel_ev
            ELSE NULL::numeric
        END AS base_parallel_ev,
        CASE
            WHEN (p.model_set_id = 2332) THEN m.insert_ev
            WHEN ((p.model_set_id = 2420) AND
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END) THEN s.insert_ev
            ELSE NULL::numeric
        END AS insert_ev,
        CASE
            WHEN (p.model_set_id = 2332) THEN m.fotl_exclusive_ev
            WHEN ((p.model_set_id = 2420) AND (p.pack_type = 'fotl'::text) AND s.fotl_modeled) THEN s.fotl_exclusive_ev
            ELSE NULL::numeric
        END AS fotl_exclusive_ev,
        CASE
            WHEN (p.model_set_id = 2332) THEN m.model_note
            WHEN ((p.model_set_id = 2420) AND
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END) THEN s.model_note
            WHEN (p.model_set_id = 2420) THEN 'not modeled yet · the sales model for this product needs >=10 sales in every card family of this pack and a fit under 6 hours old; EV is withheld, not zero'::text
            WHEN ((g.model_note IS NOT NULL) AND (g.computed_at <= (now() - '06:00:00'::interval))) THEN 'not modeled · the guaranteed-contents model has not refreshed in 6 hours; EV is withheld, not zero'::text
            WHEN (g.model_note IS NOT NULL) THEN g.model_note
            WHEN (p.product_set_id = ANY (ARRAY[2332, 2420])) THEN 'not modeled · the EV model covers this product''s standard Hobby and FOTL packs only; this pack''s contents and odds differ; EV is withheld, not zero'::text
            ELSE 'not modeled · no pack-EV model exists for this product yet (card prices for it are not collected); EV is withheld, not zero'::text
        END AS model_note,
        CASE
            WHEN ((p.model_set_id = 2332) AND (COALESCE(p.floor_usd, p.avg_sale_usd) > (0)::numeric)) THEN round((
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd)))
            WHEN ((p.model_set_id = 2420) AND (COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd) > (0)::numeric) AND
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END) THEN round((
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_actual_ev
                ELSE s.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd)))
            WHEN ((p.model_set_id IS NULL) AND (g.ev_modeled IS TRUE) AND (g.computed_at > (now() - '06:00:00'::interval)) AND (COALESCE(p.floor_usd, p.avg_sale_usd) > (0)::numeric)) THEN round((g.actual_ev_usd - COALESCE(p.floor_usd, p.avg_sale_usd)))
            ELSE NULL::numeric
        END AS net_rip_edge_usd,
    p.updated_at,
    p.product_name,
    p.sport,
    p.product_set_id,
    (((p.model_set_id = 2332) IS TRUE) OR ((p.model_set_id = 2420) AND (
        CASE
            WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
            ELSE s.hobby_modeled
        END IS TRUE)) OR ((p.model_set_id IS NULL) AND (g.ev_modeled IS TRUE) AND (g.computed_at > (now() - '06:00:00'::interval)))) AS ev_modeled
   FROM (((( SELECT ps.id,
            ps.collection_id,
            ps.pack_type,
            ps.price_usd,
            ps.cards_per_pack,
            ps.packs_total,
            ps.packs_remaining,
            ps.gross_ev_usd,
            ps.net_ev_usd,
            ps.updated_at,
            ps.floor_usd,
            ps.avg_sale_usd,
            ps.recent_sale_usd,
            ps.top_sale_usd,
            ps.raw,
            ps.product_name,
            ps.sport,
            ps.product_set_id,
            ps.page_url,
                CASE
                    WHEN ((ps.product_set_id = 2332) AND (ps.id = ANY (ARRAY['1038'::text, '1039'::text]))) THEN 2332
                    WHEN ((ps.product_set_id = 2420) AND (ps.id = ANY (ARRAY['1055'::text, '1056'::text]))) THEN 2420
                    ELSE NULL::integer
                END AS model_set_id
           FROM panini_pack_state ps) p
     CROSS JOIN panini_pack_ev_model m)
     LEFT JOIN panini_pack_ev_model_wnba_2026_sales s ON ((s.product_set_id = p.model_set_id)))
     LEFT JOIN mv_panini_pack_ev_guaranteed g ON (((g.pack_id = p.id) AND (p.model_set_id IS NULL))));
