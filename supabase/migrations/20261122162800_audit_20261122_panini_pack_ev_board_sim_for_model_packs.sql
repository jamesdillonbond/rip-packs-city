-- Board: simulations shown for any product-model pack (1038 WC Hobby, 1056 WNBA Hobby; FOTL packs when their sim runs) or pool pack. Same columns/order.
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
            WHEN up.use_pool THEN pl.actual_ev_usd
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
            WHEN up.use_pool THEN pl.typical_ev_usd::double precision
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
            WHEN fw.withheld THEN ((('not modeled · only '::text || COALESCE(m.fotl_remain_indexed, 0::bigint)) || ' of the '::text) || p.packs_remaining) || ' FOTL-exclusive cards still in these packs are indexed — Panini shows a card only once it has been listed for sale, so the exclusive slot would be priced from an unrepresentative part of its supply; EV is withheld, not zero'::text
            WHEN p.model_set_id = 2332 THEN m.model_note
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.model_note
            WHEN p.model_set_id = 2420 THEN 'not modeled yet · the sales model for this product needs >=10 sales in every card family of this pack and a fit under 6 hours old; EV is withheld, not zero'::text
            WHEN up.use_pool THEN pl.model_note
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
            WHEN up.use_pool AND COALESCE(p.floor_usd, p.avg_sale_usd) > 0::numeric THEN round(pl.actual_ev_usd - COALESCE(p.floor_usd, p.avg_sale_usd))
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
        END IS TRUE OR p.model_set_id IS NULL AND g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval) OR up.use_pool) AS ev_modeled,
        CASE
            WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) AND (p.model_set_id IS NOT NULL OR up.use_pool) THEN ps.median_pull_usd
            ELSE NULL::numeric
        END AS sim_median_pull_usd,
        CASE
            WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) AND (p.model_set_id IS NOT NULL OR up.use_pool) THEN ps.p_beat_cost
            ELSE NULL::numeric
        END AS sim_p_beat_cost,
        CASE
            WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) AND (p.model_set_id IS NOT NULL OR up.use_pool) THEN ps.cost_usd
            ELSE NULL::numeric
        END AS sim_cost_usd,
        CASE
            WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) AND (p.model_set_id IS NOT NULL OR up.use_pool) THEN ps.computed_at
            ELSE NULL::timestamp with time zone
        END AS sim_computed_at
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
     CROSS JOIN LATERAL ( SELECT NOT p.model_set_id IS DISTINCT FROM 2332 AND p.pack_type = 'fotl'::text AND NOT COALESCE(m.fotl_remain_indexed::numeric >= (0.9 * p.packs_remaining::numeric), false) AS withheld) fw
     LEFT JOIN panini_pack_ev_model_wnba_2026_sales s ON s.product_set_id = p.model_set_id
     LEFT JOIN mv_panini_pack_ev_guaranteed g ON g.pack_id = p.id AND p.model_set_id IS NULL
     LEFT JOIN panini_pack_ev_pool pl ON pl.pack_id = p.id AND p.model_set_id IS NULL
     CROSS JOIN LATERAL ( SELECT p.model_set_id IS NULL
                AND NOT (g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval))
                AND COALESCE(pl.modeled, false)
                AND pl.computed_at > (now() - '06:00:00'::interval) AS use_pool) up
     LEFT JOIN panini_pack_ev_sim ps ON ps.pack_id = p.id;
alter view public.panini_pack_ev_board set (security_invoker = on);