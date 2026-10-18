-- Panini WC FOTL pack EV is WITHHELD while its exclusive-card supply is under-indexed.
--
-- WHY (2026-10-18 ~9:30 AM PT, Claude Code cloud; panini.md Next 4): every FOTL pack (1039) guarantees ONE
-- FOTL-exclusive card (pack_label: "1 FOTL-exclusive Base Parallel card (#/11, #/9, #/7 or 1/1)"), so the
-- exclusive cards still in packs must equal the FOTL packs remaining. Read live: packs_remaining 1,416, but
-- the indexed editions sum to still_in_packs 740 (52 %). 1,004 of the 1,996 expected exclusive editions
-- (499 players x 4 parallels) are indexed — Panini exposes a card only once it has been listed for sale,
-- so the thinly listed #/7..#/11 exclusives are half missing. Positive control, same read: every other
-- family is fully covered (Silver 14,007 vs 13,882 expected · base parallel 11,989 vs 11,453 · insert
-- 2,310 vs 2,429). The missing exclusives skew to cheaper players (Red-parallel FMV mean $3.21 for
-- players with no Aguila edition vs $6.19 with one), so the leg's supply-weighted mean ($96) is biased
-- UP and the board's published FOTL edge (+$25 vs a $209 floor) is not supported (rough re-weight ~+$3).
--
-- WHAT: panini_pack_ev_model gains one APPENDED column, fotl_remain_indexed (sum of still_in_packs over
-- every indexed exclusive edition, priced or not). panini_pack_ev_board withholds the FOTL pack's EV,
-- typical pull, legs and edge (NULL, ev_modeled=false, a model_note stating the coverage) while
-- fotl_remain_indexed < 90 % of packs_remaining. The Hobby pack (1038) is unaffected except that it no
-- longer carries fotl_exclusive_ev (a FOTL-only figure the 2332 branch returned for every pack type).
-- Columns of both views are otherwise unchanged (order and names), so CREATE OR REPLACE is legal.
--
-- REVERT: re-apply the panini_pack_ev_board body from
-- 20261004004005_audit_20261003_panini_pack_ev_board_models_only_its_own_packs.sql as later amended
-- (live body captured in this file's history: the board as of 2026-10-18 equals this file with the `fw`
-- lateral and every `fw.withheld` branch removed and fotl_exclusive_ev's 2332 branch unconditional), then
-- the model is harmless to leave (an extra trailing column). Re-set security_invoker=on after either.

CREATE OR REPLACE VIEW public.panini_pack_ev_model AS
 WITH ed AS (
         SELECT
                CASE
                    WHEN e.set_name ~~* 'Base Prizms Silver'::text THEN 'silver'::text
                    WHEN e.parallel_family = 'fotl_exclusive'::text THEN 'fotl'::text
                    WHEN e.parallel_family = 'base'::text THEN 'base'::text
                    ELSE 'insert'::text
                END AS cls,
            COALESCE(e.still_in_packs, 0) AS remain,
            ( SELECT fs.fmv_usd
                   FROM panini_fmv_snapshots fs
                  WHERE fs.edition_id = e.id
                  ORDER BY fs.computed_at DESC
                 LIMIT 1) AS fmv
           FROM panini_editions e
          WHERE e.external_id ~~ 'packcard-2332\_%'::text
        ), agg AS (
         SELECT ed.cls,
            sum(ed.fmv * ed.remain::numeric) / NULLIF(sum(ed.remain), 0)::numeric AS sw,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (
                CASE
                    WHEN ed.remain > 0 THEN ed.fmv
                    ELSE NULL::numeric
                END::double precision)) AS med
           FROM ed
          WHERE ed.fmv IS NOT NULL
          GROUP BY ed.cls
        ), p AS (
         SELECT max(agg.sw) FILTER (WHERE agg.cls = 'silver'::text) AS silver_sw,
            max(agg.med) FILTER (WHERE agg.cls = 'silver'::text) AS silver_med,
            max(agg.sw) FILTER (WHERE agg.cls = 'base'::text) AS base_sw,
            max(agg.med) FILTER (WHERE agg.cls = 'base'::text) AS base_med,
            max(agg.sw) FILTER (WHERE agg.cls = 'insert'::text) AS insert_sw,
            max(agg.med) FILTER (WHERE agg.cls = 'insert'::text) AS insert_med,
            max(agg.sw) FILTER (WHERE agg.cls = 'fotl'::text) AS fotl_sw,
            max(agg.med) FILTER (WHERE agg.cls = 'fotl'::text) AS fotl_med,
            ( SELECT sum(ed.remain) FROM ed WHERE ed.cls = 'fotl'::text) AS fotl_remain
           FROM agg
        )
 SELECT round(silver_sw) AS silver_ev,
    round(base_sw) AS base_parallel_ev,
    round(insert_sw) AS insert_ev,
    round(fotl_sw) AS fotl_exclusive_ev,
    round(2::numeric * silver_sw + 1.65 * base_sw + 0.35 * insert_sw) AS hobby_actual_ev,
    round(2::double precision * silver_med + 1.65::double precision * base_med + 0.35::double precision * insert_med) AS hobby_typical_ev,
    round(2::numeric * silver_sw + 1.65 * base_sw + 0.35 * insert_sw + fotl_sw) AS fotl_actual_ev,
    round(2::double precision * silver_med + 1.65::double precision * base_med + 0.35::double precision * insert_med + fotl_med) AS fotl_typical_ev,
    'panini-pack-ev-0.5 · REMAINING-BASIS (families weighted by still_in_packs, typical over pullable editions) · Hobby 4 cards = 2 Silver + 1 base parallel + (base parallel or insert 7/20) · FOTL = Hobby + 1 guaranteed exclusive · card counts per Panini pack_label/description, 2026-09-29'::text AS model_note,
    fotl_remain AS fotl_remain_indexed
   FROM p;

ALTER VIEW public.panini_pack_ev_model SET (security_invoker = on);

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
        END IS TRUE OR p.model_set_id IS NULL AND g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval)) AS ev_modeled
   FROM ( SELECT ps.id,
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
                    WHEN ps.product_set_id = 2332 AND (ps.id = ANY (ARRAY['1038'::text, '1039'::text])) THEN 2332
                    WHEN ps.product_set_id = 2420 AND (ps.id = ANY (ARRAY['1055'::text, '1056'::text])) THEN 2420
                    ELSE NULL::integer
                END AS model_set_id
           FROM panini_pack_state ps) p
     CROSS JOIN panini_pack_ev_model m
     -- The FOTL coverage gate (2026-10-18). FALSE whenever it does not apply; an unknown packs_remaining
     -- or exclusive count withholds (unknown coverage is not coverage).
     CROSS JOIN LATERAL ( SELECT p.model_set_id IS NOT DISTINCT FROM 2332 AND p.pack_type = 'fotl'::text
            AND NOT COALESCE(m.fotl_remain_indexed::numeric >= 0.9 * p.packs_remaining::numeric, false) AS withheld) fw
     LEFT JOIN panini_pack_ev_model_wnba_2026_sales s ON s.product_set_id = p.model_set_id
     LEFT JOIN mv_panini_pack_ev_guaranteed g ON g.pack_id = p.id AND p.model_set_id IS NULL;

ALTER VIEW public.panini_pack_ev_board SET (security_invoker = on);
