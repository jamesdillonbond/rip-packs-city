-- audit_20260929_panini_pack_ev_two_silver
--
-- panini_pack_ev_model counted THREE Silver-tier cards per WC pack (3 x silver + 1.65 x base + 0.35 x
-- insert = 5 cards for Hobby, 6 for FOTL). Panini's own pack data says Hobby is 4 cards and FOTL 5
-- (panini_pack_state.raw.cards_per_subpack = 4 / 5, read 2026-09-29), and the published description
-- spells the 4: "2 Base Silver (#/259), 1 Base Non-Silver Parallel, 1 additional Base Non-Silver
-- Parallel - OR - a 35% chance at an Insert". pack_label's "1 Other Card" IS that either/or slot, not a
-- third card; docs/strategy/panini-fmv-packev-methodology.md had listed "the unspecified other card is
-- valued as a common" as a soft assumption and described Hobby as 5 cards. So every WC pack EV carried
-- one phantom Silver-tier card (silver_ev ~$3 at the time).
-- The change is exactly the four "(3)::" Silver weights -> "(2)::" plus the model_note version; the
-- rest of the body is the live definition (md5 of the normalized live viewdef = this file's source
-- body before the edit, ce2d79c8..., checked 2026-09-29 PT). Column names/order/types unchanged;
-- security_invoker restated (CREATE OR REPLACE VIEW resets reloptions otherwise).

create or replace view public.panini_pack_ev_model with (security_invoker = on) as
 WITH ed AS (
         SELECT
                CASE
                    WHEN (e.set_name ~~* 'Base Prizms Silver'::text) THEN 'silver'::text
                    WHEN (e.parallel_family = 'fotl_exclusive'::text) THEN 'fotl'::text
                    WHEN (e.parallel_family = 'base'::text) THEN 'base'::text
                    ELSE 'insert'::text
                END AS cls,
            COALESCE(e.still_in_packs, 0) AS remain,
            ( SELECT fs.fmv_usd
                   FROM panini_fmv_snapshots fs
                  WHERE (fs.edition_id = e.id)
                  ORDER BY fs.computed_at DESC
                 LIMIT 1) AS fmv
           FROM panini_editions e
          WHERE (e.external_id ~~ 'packcard-2332\_%'::text)
        ), agg AS (
         SELECT ed.cls,
            (sum((ed.fmv * (ed.remain)::numeric)) / (NULLIF(sum(ed.remain), 0))::numeric) AS sw,
            percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((
                CASE
                    WHEN (ed.remain > 0) THEN ed.fmv
                    ELSE NULL::numeric
                END)::double precision)) AS med
           FROM ed
          WHERE (ed.fmv IS NOT NULL)
          GROUP BY ed.cls
        ), p AS (
         SELECT max(agg.sw) FILTER (WHERE (agg.cls = 'silver'::text)) AS silver_sw,
            max(agg.med) FILTER (WHERE (agg.cls = 'silver'::text)) AS silver_med,
            max(agg.sw) FILTER (WHERE (agg.cls = 'base'::text)) AS base_sw,
            max(agg.med) FILTER (WHERE (agg.cls = 'base'::text)) AS base_med,
            max(agg.sw) FILTER (WHERE (agg.cls = 'insert'::text)) AS insert_sw,
            max(agg.med) FILTER (WHERE (agg.cls = 'insert'::text)) AS insert_med,
            max(agg.sw) FILTER (WHERE (agg.cls = 'fotl'::text)) AS fotl_sw,
            max(agg.med) FILTER (WHERE (agg.cls = 'fotl'::text)) AS fotl_med
           FROM agg
        )
 SELECT round(silver_sw) AS silver_ev,
    round(base_sw) AS base_parallel_ev,
    round(insert_sw) AS insert_ev,
    round(fotl_sw) AS fotl_exclusive_ev,
    round(((((2)::numeric * silver_sw) + (1.65 * base_sw)) + (0.35 * insert_sw))) AS hobby_actual_ev,
    round(((((2)::double precision * silver_med) + ((1.65)::double precision * base_med)) + ((0.35)::double precision * insert_med))) AS hobby_typical_ev,
    round((((((2)::numeric * silver_sw) + (1.65 * base_sw)) + (0.35 * insert_sw)) + fotl_sw)) AS fotl_actual_ev,
    round((((((2)::double precision * silver_med) + ((1.65)::double precision * base_med)) + ((0.35)::double precision * insert_med)) + fotl_med)) AS fotl_typical_ev,
    'panini-pack-ev-0.5 · REMAINING-BASIS (families weighted by still_in_packs, typical over pullable editions) · Hobby 4 cards = 2 Silver + 1 base parallel + (base parallel or insert 7/20) · FOTL = Hobby + 1 guaranteed exclusive · card counts per Panini pack_label/description, 2026-09-29'::text AS model_note
   FROM p;

