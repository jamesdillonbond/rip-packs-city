-- candy_pack_ev_model joined the shared `fmv_current` view (DISTINCT ON latest-per-edition
-- over ALL of fmv_snapshots) on edition_id ALONE. With no collection predicate the planner
-- must materialize latest-FMV for ALL 26,888 editions -- a Merge Append of 1,069,488 snapshot
-- rows through a Unique -- and only then hash-join down to Candy's 125. That one node was
-- 1,007,009 of 1,023,629 buffers (98% of all traffic).
--
-- Measured (EXPLAIN ANALYZE, TIMING OFF -- TIMING ON overstates this plan by ~4x because
-- per-node instrumentation on 1.07M rows adds ~18.7s):
--   candy_pack_ev_model  3,006 ms   (its own liveness cap is 3,000 ms -- sitting ON the cap)
--   candy_pack_market    5,969 ms   (cap 3,000 ms; it inlines this view via LEFT JOIN LATERAL)
--
-- Fix: scope the latest-FMV lookup to the Candy collection so it rides
-- fmv_snapshots_<year>_collection_id_edition_id_computed_at_idx instead of scanning every
-- edition. Same remedy proven on allday_scarcity_board on 2026-08-10.
--
-- This changes the FETCH PATH ONLY -- no pricing math is touched. Verified output-identical
-- BEFORE applying:
--   * fmv_current is a plain DISTINCT ON (edition_id) ORDER BY computed_at DESC, no other filter
--   * all 2,098 fmv_snapshots rows for Candy editions carry the Candy collection_id
--     (0 wrong/null, all 125 editions covered), so the scoped predicate drops nothing
--   * 0 editions tie at max(computed_at), so neither form is order-dependent
--   * EXCEPT ALL in BOTH directions = 0 rows over all 125 editions (125 = 125)
--
-- Rollback: restore the LEFT JOIN fmv_current form, i.e. replace the `fc` CTE below with
--   LEFT JOIN fmv_current fc ON fc.edition_id = e.id
-- and drop the CTE. No data change to unwind.
CREATE OR REPLACE VIEW public.candy_pack_ev_model AS
 WITH fc AS (
         SELECT DISTINCT ON (fmv_snapshots.edition_id) fmv_snapshots.edition_id,
            fmv_snapshots.fmv_usd
           FROM fmv_snapshots
          WHERE fmv_snapshots.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
          ORDER BY fmv_snapshots.edition_id, fmv_snapshots.computed_at DESC
        ), ed AS (
         SELECT e.tier,
            e.circulation_count AS circ,
            fc.fmv_usd AS fmv
           FROM editions e
             LEFT JOIN fc ON fc.edition_id = e.id
          WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
        ), agg AS (
         SELECT ed.tier,
            count(*) AS total,
            count(*) FILTER (WHERE ed.fmv IS NOT NULL AND ed.fmv > 0::numeric) AS priced,
            sum(ed.fmv * ed.circ::numeric) FILTER (WHERE ed.fmv IS NOT NULL) / NULLIF(sum(ed.circ) FILTER (WHERE ed.fmv IS NOT NULL), 0)::numeric AS sw_mean,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (ed.fmv::double precision)) FILTER (WHERE ed.fmv IS NOT NULL AND ed.fmv > 0::numeric)::numeric AS med
           FROM ed
          GROUP BY ed.tier
        ), p AS (
         SELECT max(agg.sw_mean) FILTER (WHERE agg.tier = 'COMMON'::tier_type) AS common_sw,
            max(agg.med) FILTER (WHERE agg.tier = 'COMMON'::tier_type) AS common_med,
            max(agg.total) FILTER (WHERE agg.tier = 'COMMON'::tier_type) AS common_total,
            max(agg.priced) FILTER (WHERE agg.tier = 'COMMON'::tier_type) AS common_priced,
            max(agg.sw_mean) FILTER (WHERE agg.tier = 'LEGENDARY'::tier_type) AS rainbow_sw,
            max(agg.med) FILTER (WHERE agg.tier = 'LEGENDARY'::tier_type) AS rainbow_med,
            max(agg.total) FILTER (WHERE agg.tier = 'LEGENDARY'::tier_type) AS rainbow_total,
            max(agg.priced) FILTER (WHERE agg.tier = 'LEGENDARY'::tier_type) AS rainbow_priced
           FROM agg
        )
 SELECT 10 AS icon_slots,
    0.15 AS rainbow_chance,
    10::numeric AS pack_cost_usd,
    round(common_sw, 2) AS common_slot_ev,
    round(common_med, 2) AS common_slot_typical,
    round(rainbow_sw, 2) AS rainbow_ev,
    common_total,
    common_priced,
    rainbow_total,
    rainbow_priced,
    round(10::numeric * common_sw + 0.15 * COALESCE(rainbow_sw, 0::numeric), 2) AS actual_ev_usd,
    round(10::numeric * common_med, 2) AS typical_pull_ev_usd,
    (((((((((('candy-pack-ev-0.1 · $10 pack = 10 ICONs + 15% Rainbow chance · supply-weighted · '::text || 'Actual EV = chase-inclusive MEAN; Typical Pull = 10 × median common (the median pack pulls no Rainbow) · '::text) || 'Rainbow leg largely UNPRICED ('::text) || COALESCE(rainbow_priced, 0::bigint)) || '/'::text) || COALESCE(rainbow_total, 0::bigint)) || '), commons '::text) || COALESCE(common_priced, 0::bigint)) || '/'::text) || COALESCE(common_total, 0::bigint)) || ' priced · secondary market ultra-thin + all FMV '::text) || 'LOW-confidence + Drop 3 adds forward supply → indicative pull value, NOT liquidation value'::text AS model_note
   FROM p;