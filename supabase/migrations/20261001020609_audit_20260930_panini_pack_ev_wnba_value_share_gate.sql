-- audit_20260930_panini_pack_ev_wnba_value_share_gate
--
-- Tightens the 2026 Prizm WNBA (2420) pack-EV gate from 20260930222440. "Every family has >=3
-- sale-backed editions" passed on a COUNT while the VALUE was ask-driven. Measured 2026-09-30
-- ~7:10 PM PT (387 editions): the FOTL pack went ev_modeled with +$20 edge at fotl_n=6, but
-- sale-backed editions carried only 15% of the exclusive family's remaining-weighted value
-- (18 ASK_ONLY editions carried 85%); base 33%, insert 20%, silver 90%. The 2026 WC model's
-- families sit at 81-100% (silver 1.00 / base 0.85 / insert 0.99 / fotl 0.81), so the WC board
-- would pass this gate unchanged — it is applied to the WNBA view only.
-- Valued on sale-backed editions alone at that moment: Hobby ~$21 vs $30, FOTL ~$114 vs $150 —
-- the published +$6 / +$20 edges were ask artefacts.
-- New gate: a pack is modeled only when every family in it ALSO has sale-backed editions carrying
-- >= 50% of its value. Four *_sale_share columns appended (CREATE OR REPLACE VIEW can only append).
-- panini_pack_ev_board: only the not-modeled note text changes. security_invoker restated.
--
-- REVERT: CREATE OR REPLACE cannot drop the appended columns, so: DROP VIEW public.panini_pack_ev_board;
--         DROP VIEW public.panini_pack_ev_model_wnba_2026; re-run 20260930222440's body; then
--         GRANT ALL ON public.panini_pack_ev_board TO service_role (its pre-drop grant).

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
    count(*) FILTER (WHERE ed.sale_backed) AS n_sale_backed,
    sum(ed.fmv * ed.remain::numeric) FILTER (WHERE ed.sale_backed) / NULLIF(sum(ed.fmv * ed.remain::numeric), 0) AS sb_share
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
    COALESCE(max(n_sale_backed) FILTER (WHERE cls = 'fotl'), 0) AS fotl_n,
    COALESCE(max(sb_share) FILTER (WHERE cls = 'silver'), 0) AS silver_share,
    COALESCE(max(sb_share) FILTER (WHERE cls = 'base'), 0) AS base_share,
    COALESCE(max(sb_share) FILTER (WHERE cls = 'insert'), 0) AS insert_share,
    COALESCE(max(sb_share) FILTER (WHERE cls = 'fotl'), 0) AS fotl_share
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
  (silver_n >= 3 AND base_n >= 3 AND insert_n >= 3
     AND silver_share >= 0.5 AND base_share >= 0.5 AND insert_share >= 0.5) AS hobby_modeled,
  (silver_n >= 3 AND base_n >= 3 AND insert_n >= 3 AND fotl_n >= 3
     AND silver_share >= 0.5 AND base_share >= 0.5 AND insert_share >= 0.5 AND fotl_share >= 0.5) AS fotl_modeled,
  silver_n, base_n, insert_n, fotl_n,
  'panini-pack-ev-wnba-0.2 · 2026 Prizm WNBA (setId 2420) · REMAINING-BASIS (families weighted by still_in_packs, typical over pullable editions) · Hobby 4 cards = 2 Silver #/296 + 1 non-Silver base parallel + (non-Silver base parallel or insert 1/4) · FOTL = Hobby + 1 exclusive (Cherry Blossom #/17, Plum Blossom #/8, Lotus Flower #/3) · per Panini pack_label/description 2026-09-29 · a pack is modeled only when every family in it has >=3 sale-backed (HIGH/MEDIUM/LOW) editions AND sale-backed editions carry >=50% of the family''s value'::text AS model_note,
  round(silver_share, 2) AS silver_sale_share,
  round(base_share, 2) AS base_sale_share,
  round(insert_share, 2) AS insert_sale_share,
  round(fotl_share, 2) AS fotl_sale_share
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
            WHEN (p.product_set_id = 2420) THEN 'not modeled yet · a card family in this pack is still priced mostly from asks, not sales (needs >=3 sale-backed editions carrying >=50% of its value); EV is withheld, not zero'::text
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
