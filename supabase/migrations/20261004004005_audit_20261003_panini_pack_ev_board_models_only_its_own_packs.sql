-- panini_pack_ev_board: the EV models describe FOUR specific packs, not every pack of their product.
--
-- WHY (2026-10-03 ~5:45 PM PT): the board keyed "modeled" on product_set_id alone — every pack of 2332
-- (2026 Prizm World Cup) took the WC Hobby/FOTL model, and every non-FOTL pack of 2420 (2026 Prizm
-- WNBA) the WNBA Hobby model. Until today a product only ever had those packs. The residential runner
-- now walks Panini's SECONDARY pack listings (64 basketball pack pages on the first pass, one listing
-- per sport from the 6:00 PM PT run), and a pack is tied to its product by collection_name — so a WC or
-- WNBA parallel/insert pack (e.g. a "Gold Vinyl Parallel Pack": different contents, different odds)
-- would have published the Hobby pack's EV as its own. The model is the contents+odds of:
--   2332: 1038 (Hobby), 1039 (FOTL)   ·   2420: 1056 (Hobby), 1055 (FOTL)
-- Every expression now reads `model_set_id` (the product id only for those four packs, else NULL); the
-- view's columns, including the real product_set_id, are unchanged. Another pack of a modeled product
-- says so in model_note instead of claiming "no card prices are collected".
-- reloptions: CREATE OR REPLACE VIEW resets them; security_invoker=on is re-set below.

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
            WHEN p.model_set_id = 2332 THEN
            CASE
                WHEN p.pack_type = 'fotl'::text THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END
            WHEN p.model_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled THEN s.fotl_actual_ev
            WHEN p.model_set_id = 2420 AND p.pack_type IS DISTINCT FROM 'fotl'::text AND s.hobby_modeled THEN s.hobby_actual_ev
            ELSE NULL::numeric
        END AS actual_ev_usd,
        CASE
            WHEN p.model_set_id = 2332 THEN
            CASE
                WHEN p.pack_type = 'fotl'::text THEN m.fotl_typical_ev
                ELSE m.hobby_typical_ev
            END
            WHEN p.model_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled THEN s.fotl_typical_ev::double precision
            WHEN p.model_set_id = 2420 AND p.pack_type IS DISTINCT FROM 'fotl'::text AND s.hobby_modeled THEN s.hobby_typical_ev::double precision
            ELSE NULL::double precision
        END AS typical_ev_usd,
        CASE
            WHEN p.model_set_id = 2332 THEN m.silver_ev
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.silver_ev
            ELSE NULL::numeric
        END AS silver_ev,
        CASE
            WHEN p.model_set_id = 2332 THEN m.base_parallel_ev
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.base_parallel_ev
            ELSE NULL::numeric
        END AS base_parallel_ev,
        CASE
            WHEN p.model_set_id = 2332 THEN m.insert_ev
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.insert_ev
            ELSE NULL::numeric
        END AS insert_ev,
        CASE
            WHEN p.model_set_id = 2332 THEN m.fotl_exclusive_ev
            WHEN p.model_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled THEN s.fotl_exclusive_ev
            ELSE NULL::numeric
        END AS fotl_exclusive_ev,
        CASE
            WHEN p.model_set_id = 2332 THEN m.model_note
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.model_note
            WHEN p.model_set_id = 2420 THEN 'not modeled yet · the sales model for this product needs >=10 sales in every card family of this pack and a fit under 6 hours old; EV is withheld, not zero'::text
            WHEN p.product_set_id = ANY (ARRAY[2332, 2420]) THEN 'not modeled · the EV model covers this product''s standard Hobby and FOTL packs only; this pack''s contents and odds differ; EV is withheld, not zero'::text
            ELSE 'not modeled · no pack-EV model exists for this product yet (card prices for it are not collected); EV is withheld, not zero'::text
        END AS model_note,
        CASE
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
            ELSE NULL::numeric
        END AS net_rip_edge_usd,
    p.updated_at,
    p.product_name,
    p.sport,
    p.product_set_id,
    (p.model_set_id = 2332) IS TRUE OR p.model_set_id = 2420 AND
        CASE
            WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
            ELSE s.hobby_modeled
        END IS TRUE AS ev_modeled
   FROM ( SELECT ps.*,
                CASE
                    WHEN ps.product_set_id = 2332 AND ps.id = ANY (ARRAY['1038'::text, '1039'::text]) THEN 2332
                    WHEN ps.product_set_id = 2420 AND ps.id = ANY (ARRAY['1055'::text, '1056'::text]) THEN 2420
                    ELSE NULL::integer
                END AS model_set_id
           FROM panini_pack_state ps) p
     CROSS JOIN panini_pack_ev_model m
     LEFT JOIN panini_pack_ev_model_wnba_2026_sales s ON s.product_set_id = p.model_set_id;

ALTER VIEW public.panini_pack_ev_board SET (security_invoker = on);
