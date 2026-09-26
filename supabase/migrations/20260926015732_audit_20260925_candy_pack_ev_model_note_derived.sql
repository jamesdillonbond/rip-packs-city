-- audit_20260925_candy_pack_ev_model_note_derived
--
-- candy_pack_ev_model.model_note HARDCODED two claims that expired while the
-- note kept printing them (a suppression whose premise died — CLAUDE.md honesty):
--   "Rainbow leg largely UNPRICED (25/25)"   — read live 2026-09-25: 25 of 25
--       Rainbow editions carry an FMV, so the sentence contradicted its own count.
--   "all FMV LOW-confidence"                  — read live 2026-09-25: 23 of 125
--       Candy editions are MEDIUM (17 of 25 Rainbow, 6 of 100 commons).
-- The note now DERIVES both from the same rows it counts, so it cannot drift again:
-- the priced counts are stated as counts (no adjective), and the confidence clause
-- is the LOW share measured in this view's own `fc` CTE.
--
-- Output columns are identical in name, order and type (CREATE OR REPLACE VIEW
-- cannot change them; candy_pack_market depends on this view). No pricing math is
-- touched: every numeric column is the same expression as 20260811033305.
-- Only `fc` gains `confidence`, read from the same DISTINCT ON row.
--
-- ⚠ CREATE OR REPLACE VIEW resets reloptions, so security_invoker is re-set below
-- (the 20260811033331 repair, repeated in the same migration this time).
--
-- Rollback: re-apply the view body from
-- 20260811033305_audit_20260810_candy_pack_ev_model_scope_fmv_to_collection.sql,
-- then ALTER VIEW public.candy_pack_ev_model SET (security_invoker = on).
CREATE OR REPLACE VIEW public.candy_pack_ev_model AS
 WITH fc AS (
         SELECT DISTINCT ON (fmv_snapshots.edition_id) fmv_snapshots.edition_id,
            fmv_snapshots.fmv_usd,
            fmv_snapshots.confidence
           FROM fmv_snapshots
          WHERE (fmv_snapshots.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
          ORDER BY fmv_snapshots.edition_id, fmv_snapshots.computed_at DESC
        ), ed AS (
         SELECT e.tier,
            e.circulation_count AS circ,
            fc.fmv_usd AS fmv,
            fc.confidence AS conf
           FROM (editions e
             LEFT JOIN fc ON ((fc.edition_id = e.id)))
          WHERE (e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
        ), agg AS (
         SELECT ed.tier,
            count(*) AS total,
            count(*) FILTER (WHERE ((ed.fmv IS NOT NULL) AND (ed.fmv > (0)::numeric))) AS priced,
            (sum((ed.fmv * (ed.circ)::numeric)) FILTER (WHERE (ed.fmv IS NOT NULL)) / (NULLIF(sum(ed.circ) FILTER (WHERE (ed.fmv IS NOT NULL)), 0))::numeric) AS sw_mean,
            (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((ed.fmv)::double precision)) FILTER (WHERE ((ed.fmv IS NOT NULL) AND (ed.fmv > (0)::numeric))))::numeric AS med
           FROM ed
          GROUP BY ed.tier
        ), p AS (
         SELECT max(agg.sw_mean) FILTER (WHERE (agg.tier = 'COMMON'::tier_type)) AS common_sw,
            max(agg.med) FILTER (WHERE (agg.tier = 'COMMON'::tier_type)) AS common_med,
            max(agg.total) FILTER (WHERE (agg.tier = 'COMMON'::tier_type)) AS common_total,
            max(agg.priced) FILTER (WHERE (agg.tier = 'COMMON'::tier_type)) AS common_priced,
            max(agg.sw_mean) FILTER (WHERE (agg.tier = 'LEGENDARY'::tier_type)) AS rainbow_sw,
            max(agg.med) FILTER (WHERE (agg.tier = 'LEGENDARY'::tier_type)) AS rainbow_med,
            max(agg.total) FILTER (WHERE (agg.tier = 'LEGENDARY'::tier_type)) AS rainbow_total,
            max(agg.priced) FILTER (WHERE (agg.tier = 'LEGENDARY'::tier_type)) AS rainbow_priced
           FROM agg
        ), cf AS (
         SELECT count(*) FILTER (WHERE (ed.conf IS NOT NULL)) AS conf_total,
            count(*) FILTER (WHERE (ed.conf = 'LOW'::fmv_confidence)) AS conf_low
           FROM ed
        )
 SELECT 10 AS icon_slots,
    0.15 AS rainbow_chance,
    (10)::numeric AS pack_cost_usd,
    round(p.common_sw, 2) AS common_slot_ev,
    round(p.common_med, 2) AS common_slot_typical,
    round(p.rainbow_sw, 2) AS rainbow_ev,
    p.common_total,
    p.common_priced,
    p.rainbow_total,
    p.rainbow_priced,
    round((((10)::numeric * p.common_sw) + (0.15 * COALESCE(p.rainbow_sw, (0)::numeric))), 2) AS actual_ev_usd,
    round(((10)::numeric * p.common_med), 2) AS typical_pull_ev_usd,
    ('candy-pack-ev-0.2 · $10 pack = 10 ICONs + 15% Rainbow chance · supply-weighted · '::text
      || 'Actual EV = chase-inclusive MEAN; Typical Pull = 10 × median common (the median pack pulls no Rainbow) · '::text
      || 'priced: Rainbow '::text || COALESCE(p.rainbow_priced, (0)::bigint) || '/'::text || COALESCE(p.rainbow_total, (0)::bigint)
      || ', commons '::text || COALESCE(p.common_priced, (0)::bigint) || '/'::text || COALESCE(p.common_total, (0)::bigint)
      || ' · FMV confidence: '::text || cf.conf_low || ' of '::text || cf.conf_total || ' LOW'::text
      || ' · secondary market thin → indicative pull value, NOT liquidation value'::text) AS model_note
   FROM p, cf;

ALTER VIEW public.candy_pack_ev_model SET (security_invoker = on);
