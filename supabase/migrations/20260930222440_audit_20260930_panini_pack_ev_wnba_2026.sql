-- audit_20260930_panini_pack_ev_wnba_2026
--
-- Pack EV for the 2026 Panini NFT Prizm WNBA packs (product setId 2420; FOTL pack 1055 $150,
-- Hobby pack 1056 $30). New model view panini_pack_ev_model_wnba_2026, same shape and basis as
-- the WC model (panini_pack_ev_model v0.5): each card family is valued at its still-in-packs-
-- weighted FMV (mean) and its median over pullable editions (typical). Contents per Panini's own
-- pack_label/description (read 2026-09-29):
--   Hobby 4 cards = 2 Base Silver #/296 + 1 non-Silver base parallel (#/169 -> 1/1)
--                   + 1 more non-Silver base parallel OR an insert (insert 1 in 4 packs)
--                   => 2 silver + 1.75 base + 0.25 insert
--   FOTL  5 cards = Hobby + 1 FOTL-exclusive base parallel (Cherry Blossom #/17, Plum Blossom #/8,
--                   Lotus Flower #/3)
-- Families come from set_name: 'Base Prizms Silver' = silver; the three exclusives = fotl; any
-- other parallel_family='base' = base; everything else (tiered + non-tiered inserts) = insert.
--
-- ⛔ ACCURACY GATE: a pack is marked ev_modeled only when EVERY family in it has >= 3 editions
-- priced from sales (confidence HIGH/MEDIUM/LOW). Measured at build (2026-09-30 ~3:30 PM PT, the
-- first bootstrap walk still running, 223 editions): silver 56 / base 47 / insert 8 sale-backed,
-- but the FOTL-exclusive family 2 of 15 priced (13 ASK_ONLY, e.g. a $600 ask-derived Cherry
-- Blossom). So Hobby 1056 is modeled and FOTL 1055 stays "not modeled yet" until its exclusives
-- trade — an ask is not a price.
--
-- panini_pack_ev_board: 2332 rows unchanged; 2420 rows take the WNBA model when gated in; every
-- other product keeps the "not modeled" note. Net edge for 2420 falls back to the primary drop
-- price (price_usd) when there is no floor/avg sale yet. Column names/order/types unchanged;
-- security_invoker restated (CREATE OR REPLACE VIEW resets reloptions otherwise).
-- Consumers: lib/insights/panini-more-boards.ts (the WC board) now also filters product_set_id=2332.
--
-- REVERT: re-create panini_pack_ev_board from 20260929224922's body (the 2332-only CASEs), then
--         DROP VIEW public.panini_pack_ev_model_wnba_2026;

CREATE OR REPLACE VIEW public.panini_pack_ev_model_wnba_2026 WITH (security_invoker = on) AS
WITH ed AS (
  SELECT
    CASE
      WHEN e.set_name ~~* 'Base Prizms Silver' THEN 'silver'
      WHEN e.set_name ~* '^Base Prizms (Cherry Blossom|Plum Blossom|Lotus Flower)$' THEN 'fotl'
      WHEN e.parallel_family = 'base' THEN 'base'
      ELSE 'insert'
    END AS cls,
    COALESCE(e.still_in_packs, 0) AS remain,
    s.fmv_usd AS fmv,
    (s.confidence::text IN ('HIGH', 'MEDIUM', 'LOW')) AS sale_backed
  FROM public.panini_editions e
  LEFT JOIN LATERAL (
    SELECT fs.fmv_usd, fs.confidence FROM public.panini_fmv_snapshots fs
     WHERE fs.edition_id = e.id ORDER BY fs.computed_at DESC LIMIT 1
  ) s ON true
  WHERE e.product_set_id = 2420
), agg AS (
  SELECT ed.cls,
    sum(ed.fmv * ed.remain::numeric) / NULLIF(sum(ed.remain), 0)::numeric AS sw,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY (CASE WHEN ed.remain > 0 THEN ed.fmv ELSE NULL END)::double precision) AS med,
    count(*) FILTER (WHERE ed.sale_backed) AS n_sale_backed
  FROM ed WHERE ed.fmv IS NOT NULL
  GROUP BY ed.cls
), p AS (
  SELECT
    max(sw) FILTER (WHERE cls = 'silver') AS silver_sw, max(med) FILTER (WHERE cls = 'silver') AS silver_med,
    max(sw) FILTER (WHERE cls = 'base') AS base_sw, max(med) FILTER (WHERE cls = 'base') AS base_med,
    max(sw) FILTER (WHERE cls = 'insert') AS insert_sw, max(med) FILTER (WHERE cls = 'insert') AS insert_med,
    max(sw) FILTER (WHERE cls = 'fotl') AS fotl_sw, max(med) FILTER (WHERE cls = 'fotl') AS fotl_med,
    COALESCE(max(n_sale_backed) FILTER (WHERE cls = 'silver'), 0) AS silver_n,
    COALESCE(max(n_sale_backed) FILTER (WHERE cls = 'base'), 0) AS base_n,
    COALESCE(max(n_sale_backed) FILTER (WHERE cls = 'insert'), 0) AS insert_n,
    COALESCE(max(n_sale_backed) FILTER (WHERE cls = 'fotl'), 0) AS fotl_n
  FROM agg
)
SELECT
  round(silver_sw) AS silver_ev,
  round(base_sw) AS base_parallel_ev,
  round(insert_sw) AS insert_ev,
  round(fotl_sw) AS fotl_exclusive_ev,
  round(2::numeric * silver_sw + 1.75 * base_sw + 0.25 * insert_sw) AS hobby_actual_ev,
  round(2::double precision * silver_med + 1.75::double precision * base_med + 0.25::double precision * insert_med) AS hobby_typical_ev,
  round(2::numeric * silver_sw + 1.75 * base_sw + 0.25 * insert_sw + fotl_sw) AS fotl_actual_ev,
  round(2::double precision * silver_med + 1.75::double precision * base_med + 0.25::double precision * insert_med + fotl_med) AS fotl_typical_ev,
  (silver_n >= 3 AND base_n >= 3 AND insert_n >= 3) AS hobby_modeled,
  (silver_n >= 3 AND base_n >= 3 AND insert_n >= 3 AND fotl_n >= 3) AS fotl_modeled,
  silver_n, base_n, insert_n, fotl_n,
  'panini-pack-ev-wnba-0.1 · 2026 Prizm WNBA (setId 2420) · REMAINING-BASIS (families weighted by still_in_packs, typical over pullable editions) · Hobby 4 cards = 2 Silver #/296 + 1 non-Silver base parallel + (non-Silver base parallel or insert 1/4) · FOTL = Hobby + 1 exclusive (Cherry Blossom #/17, Plum Blossom #/8, Lotus Flower #/3) · per Panini pack_label/description 2026-09-29 · a pack is modeled only when every family in it has >=3 sale-backed (HIGH/MEDIUM/LOW) editions'::text AS model_note
FROM p;

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
            WHEN (p.product_set_id = 2420 AND p.pack_type = 'fotl'::text AND w.fotl_modeled) THEN w.fotl_actual_ev
            WHEN (p.product_set_id = 2420 AND p.pack_type IS DISTINCT FROM 'fotl'::text AND w.hobby_modeled) THEN w.hobby_actual_ev
            ELSE NULL::numeric
        END AS actual_ev_usd,
        CASE
            WHEN (p.product_set_id = 2332) THEN CASE WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_typical_ev ELSE m.hobby_typical_ev END
            WHEN (p.product_set_id = 2420 AND p.pack_type = 'fotl'::text AND w.fotl_modeled) THEN w.fotl_typical_ev
            WHEN (p.product_set_id = 2420 AND p.pack_type IS DISTINCT FROM 'fotl'::text AND w.hobby_modeled) THEN w.hobby_typical_ev
            ELSE NULL::double precision
        END AS typical_ev_usd,
        CASE
            WHEN (p.product_set_id = 2332) THEN m.silver_ev
            WHEN (p.product_set_id = 2420 AND CASE WHEN p.pack_type = 'fotl'::text THEN w.fotl_modeled ELSE w.hobby_modeled END) THEN w.silver_ev
            ELSE NULL::numeric
        END AS silver_ev,
        CASE
            WHEN (p.product_set_id = 2332) THEN m.base_parallel_ev
            WHEN (p.product_set_id = 2420 AND CASE WHEN p.pack_type = 'fotl'::text THEN w.fotl_modeled ELSE w.hobby_modeled END) THEN w.base_parallel_ev
            ELSE NULL::numeric
        END AS base_parallel_ev,
        CASE
            WHEN (p.product_set_id = 2332) THEN m.insert_ev
            WHEN (p.product_set_id = 2420 AND CASE WHEN p.pack_type = 'fotl'::text THEN w.fotl_modeled ELSE w.hobby_modeled END) THEN w.insert_ev
            ELSE NULL::numeric
        END AS insert_ev,
        CASE
            WHEN (p.product_set_id = 2332) THEN m.fotl_exclusive_ev
            WHEN (p.product_set_id = 2420 AND p.pack_type = 'fotl'::text AND w.fotl_modeled) THEN w.fotl_exclusive_ev
            ELSE NULL::numeric
        END AS fotl_exclusive_ev,
        CASE
            WHEN (p.product_set_id = 2332) THEN m.model_note
            WHEN (p.product_set_id = 2420 AND CASE WHEN p.pack_type = 'fotl'::text THEN w.fotl_modeled ELSE w.hobby_modeled END) THEN w.model_note
            WHEN (p.product_set_id = 2420) THEN 'not modeled yet · a card family in this pack does not have 3 sale-backed prices yet (FOTL-exclusive asks alone are not a price); EV is withheld, not zero'::text
            ELSE 'not modeled · no pack-EV model exists for this product yet (card prices for it are not collected); EV is withheld, not zero'::text
        END AS model_note,
        CASE
            WHEN ((p.product_set_id = 2332) AND (COALESCE(p.floor_usd, p.avg_sale_usd) > (0)::numeric)) THEN round((
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd)))
            WHEN (p.product_set_id = 2420 AND COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd) > (0)::numeric
                  AND CASE WHEN p.pack_type = 'fotl'::text THEN w.fotl_modeled ELSE w.hobby_modeled END) THEN round((
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN w.fotl_actual_ev
                ELSE w.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd)))
            ELSE NULL::numeric
        END AS net_rip_edge_usd,
    p.updated_at,
    p.product_name,
    p.sport,
    p.product_set_id,
    (((p.product_set_id = 2332) IS TRUE)
      OR (p.product_set_id = 2420 AND (CASE WHEN p.pack_type = 'fotl'::text THEN w.fotl_modeled ELSE w.hobby_modeled END) IS TRUE)) AS ev_modeled
   FROM ((public.panini_pack_state p
     CROSS JOIN public.panini_pack_ev_model m)
     CROSS JOIN public.panini_pack_ev_model_wnba_2026 w);

REVOKE ALL ON public.panini_pack_ev_model_wnba_2026 FROM anon, authenticated;
GRANT SELECT ON public.panini_pack_ev_model_wnba_2026 TO service_role;
