-- audit_20261002_panini_pack_ev_board_reads_wnba_sales_model
--
-- panini_pack_ev_board: 2420 (2026 Prizm WNBA) packs now read panini_pack_ev_model_wnba_2026_sales
-- (LEFT JOIN - no fit row = not modeled) instead of the FMV-based panini_pack_ev_model_wnba_2026,
-- which stays as a diagnostic. 2332 (WC) rows unchanged. Column names/order/types unchanged;
-- security_invoker restated. Schedules rpc-panini-pack-ev-sales-model (:46 hourly, cron_heavy);
-- pipeline_cadence_watchlist row panini-pack-ev-sales-model (150 / 300 min, info) inserted by hand.
-- Applied through a base64 DO/EXECUTE wrapper (MCP transport stall, see the model migration).
--
-- REVERT: SELECT cron.unschedule('rpc-panini-pack-ev-sales-model'); then re-create the board from
--         20261001020609's body (it reads panini_pack_ev_model_wnba_2026 w via CROSS JOIN).
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE VIEW public.panini_pack_ev_board WITH (security_invoker = on) AS
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
            WHEN (p.product_set_id = 2332) THEN CASE WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_actual_ev ELSE m.hobby_actual_ev END
            WHEN (p.product_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled) THEN s.fotl_actual_ev
            WHEN (p.product_set_id = 2420 AND p.pack_type IS DISTINCT FROM 'fotl'::text AND s.hobby_modeled) THEN s.hobby_actual_ev
            ELSE NULL::numeric
        END AS actual_ev_usd,
        CASE
            WHEN (p.product_set_id = 2332) THEN CASE WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_typical_ev ELSE m.hobby_typical_ev END
            WHEN (p.product_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled) THEN s.fotl_typical_ev::double precision
            WHEN (p.product_set_id = 2420 AND p.pack_type IS DISTINCT FROM 'fotl'::text AND s.hobby_modeled) THEN s.hobby_typical_ev::double precision
            ELSE NULL::double precision
        END AS typical_ev_usd,
        CASE
            WHEN (p.product_set_id = 2332) THEN m.silver_ev
            WHEN (p.product_set_id = 2420 AND CASE WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled ELSE s.hobby_modeled END) THEN s.silver_ev
            ELSE NULL::numeric
        END AS silver_ev,
        CASE
            WHEN (p.product_set_id = 2332) THEN m.base_parallel_ev
            WHEN (p.product_set_id = 2420 AND CASE WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled ELSE s.hobby_modeled END) THEN s.base_parallel_ev
            ELSE NULL::numeric
        END AS base_parallel_ev,
        CASE
            WHEN (p.product_set_id = 2332) THEN m.insert_ev
            WHEN (p.product_set_id = 2420 AND CASE WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled ELSE s.hobby_modeled END) THEN s.insert_ev
            ELSE NULL::numeric
        END AS insert_ev,
        CASE
            WHEN (p.product_set_id = 2332) THEN m.fotl_exclusive_ev
            WHEN (p.product_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled) THEN s.fotl_exclusive_ev
            ELSE NULL::numeric
        END AS fotl_exclusive_ev,
        CASE
            WHEN (p.product_set_id = 2332) THEN m.model_note
            WHEN (p.product_set_id = 2420 AND CASE WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled ELSE s.hobby_modeled END) THEN s.model_note
            WHEN (p.product_set_id = 2420) THEN 'not modeled yet · the sales model for this product needs >=10 sales in every card family of this pack and a fit under 6 hours old; EV is withheld, not zero'::text
            ELSE 'not modeled · no pack-EV model exists for this product yet (card prices for it are not collected); EV is withheld, not zero'::text
        END AS model_note,
        CASE
            WHEN ((p.product_set_id = 2332) AND (COALESCE(p.floor_usd, p.avg_sale_usd) > (0)::numeric)) THEN round((
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd)))
            WHEN (p.product_set_id = 2420 AND COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd) > (0)::numeric
                  AND CASE WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled ELSE s.hobby_modeled END) THEN round((
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_actual_ev
                ELSE s.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd)))
            ELSE NULL::numeric
        END AS net_rip_edge_usd,
    p.updated_at,
    p.product_name,
    p.sport,
    p.product_set_id,
    (((p.product_set_id = 2332) IS TRUE)
      OR (p.product_set_id = 2420 AND (CASE WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled ELSE s.hobby_modeled END) IS TRUE)) AS ev_modeled
   FROM ((public.panini_pack_state p
     CROSS JOIN public.panini_pack_ev_model m)
     LEFT JOIN public.panini_pack_ev_model_wnba_2026_sales s ON s.product_set_id = p.product_set_id);

SET LOCAL ROLE cron_heavy;
SELECT cron.schedule('rpc-panini-pack-ev-sales-model', '46 * * * *', 'SELECT public.refresh_panini_pack_ev_sales_model(2420);');
RESET ROLE;
DO $chk$
DECLARE v_sched text; v_user text;
BEGIN
  SELECT schedule, username INTO v_sched, v_user FROM cron.job WHERE jobname = 'rpc-panini-pack-ev-sales-model';
  IF v_sched IS DISTINCT FROM '46 * * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user IS DISTINCT FROM 'cron_heavy' THEN RAISE EXCEPTION 'owner is not cron_heavy: %', v_user; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-panini-pack-ev-sales-model') IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'duplicate job'; END IF;
END $chk$;
