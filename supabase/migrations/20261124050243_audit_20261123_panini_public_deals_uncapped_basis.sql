-- audit_20261123_panini_public_deals_uncapped_basis
--
-- 2026-11-23 (Claude Code cloud; Trevor: "Keep going" on the Panini parity pass).
--
-- DEFECT. The Panini leg of the public Below FMV board (/insights/deals, mv_panini_public_deals) has written 0 rows on
-- every hourly run since at least 2026-11-21 (pipeline_runs 'panini-public-deals', rows_written 0, ok true — a
-- structurally empty board reported as a healthy one). Its filter was `d.ask_usd < f.fmv_usd` with f =
-- edition_fmv_current. Since 2026-11-12 every Panini sale-derived FMV that reaches fmv_snapshots / edition_fmv_current
-- is CAPPED at the edition's lowest live ask (fmv_snapshots_cap_panini_low_to_live_ask) — and the deal ask IS that
-- lowest live ask. So f.fmv_usd = d.ask_usd on every candidate and the strict `<` can never hold: the cap deleted every
-- deal by construction, exactly the outcome 20261122203555 ruled out ("a DEAL is not capped … capping FMV at the ask
-- would delete every deal by construction"). Measured 11-23: 0 rows live; 13 editions on the uncapped basis.
--
-- FIX. Compare the ask with the deal board's own UNCAPPED FMV (panini_deal_board_all.fmv_usd = edition FMV from
-- panini_fmv_snapshots x serial premium; special serials are excluded here, so premium = 1). Every other gate is
-- unchanged: deal_basis 'fmv_and_recent_sales' (the ask is also < 85 % of the 30-day recent-sales median), no special
-- serial, edition confidence HIGH/MEDIUM (the ask cap never changes confidence), ask >= $1. Same 18 columns in the same
-- order, so cross_collection_deals_board is re-pointed with an identical body.
-- Cost (EXPLAIN ANALYZE 11-23): 1.98 s, 333k buffers hit, almost all inside panini_deal_board_all itself — the same
-- read the old body already paid.
--
-- HOW (no DROP; the proven 20261122203555 swap): build _v2 with the old unique key + ACL, CREATE OR REPLACE the one
-- dependent view onto it (identical columns, security_invoker kept), swap names. refresh_panini_public_deals() resolves
-- the MV by name, so it refreshes the new one unchanged. The old MV stays as mv_panini_public_deals_retired_20261123
-- (no dependents, no refresher) for a later DROP.
-- Premise: md5(pg_get_viewdef(mv_panini_public_deals)) = 8f913f7e7977b641934e128024b0826a as read 11-23.
--
-- REVERT:
--   CREATE OR REPLACE VIEW public.cross_collection_deals_board … FROM mv_panini_public_deals_retired_20261123 p …;
--   ALTER MATERIALIZED VIEW public.mv_panini_public_deals RENAME TO mv_panini_public_deals_v2;
--   ALTER MATERIALIZED VIEW public.mv_panini_public_deals_retired_20261123 RENAME TO mv_panini_public_deals;
--   (and the two index renames below, reversed)

DO $premise$
BEGIN
  IF md5(pg_get_viewdef('public.mv_panini_public_deals'::regclass)) <> '8f913f7e7977b641934e128024b0826a' THEN
    RAISE EXCEPTION 'mv_panini_public_deals changed since 2026-11-23 read; re-read before applying';
  END IF;
END
$premise$;

CREATE MATERIALIZED VIEW public.mv_panini_public_deals_v2 AS
 SELECT DISTINCT ON (d.edition_external_id) (d.edition_external_id)::character varying AS external_id,
    ((COALESCE(d.player_name, ''::text) ||
        CASE
            WHEN (d.parallel IS NOT NULL) THEN (' — '::text || d.parallel)
            ELSE ''::text
        END))::character varying AS name,
    d.player_name,
    d.parallel AS set_name,
    (d.tier)::text AS tier,
    d.mint_cap AS circulation_count,
    d.fmv_usd,
    (f.confidence)::text AS confidence,
    d.ask_usd AS low_ask,
    round((((d.fmv_usd - d.ask_usd) / d.fmv_usd) * (100)::numeric), 1) AS discount_pct,
    round((d.fmv_usd - d.ask_usd), 2) AS discount_usd,
    d.ask_confirmed_at AS ask_updated_at,
    d.product_name,
    d.recent_sales_median_usd,
    d.recent_sales_n,
    d.serial_number AS low_ask_serial,
    e.thumbnail_url,
    now() AS computed_at
   FROM ((public.panini_deal_board_all d
     JOIN public.editions e ON ((((e.external_id)::text = d.edition_external_id) AND (e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid))))
     JOIN public.edition_fmv_current f ON ((f.edition_id = e.id)))
  WHERE ((d.deal_basis = 'fmv_and_recent_sales'::text) AND (d.special_flag IS NULL)
    AND ((f.confidence)::text = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text]))
    AND (d.ask_usd >= (1)::numeric) AND (d.fmv_usd > (0)::numeric) AND (d.ask_usd < d.fmv_usd))
  ORDER BY d.edition_external_id, d.ask_usd, d.sku;

CREATE UNIQUE INDEX mv_panini_public_deals_v2_pk ON public.mv_panini_public_deals_v2 USING btree (external_id);

REVOKE ALL ON public.mv_panini_public_deals_v2 FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mv_panini_public_deals_v2 TO service_role;

CREATE OR REPLACE VIEW public.cross_collection_deals_board WITH (security_invoker = on) AS
 SELECT m.external_id,
    m.name,
    m.player_name,
    m.set_name,
    m.tier,
    m.circulation_count,
    m.fmv_usd,
    m.confidence,
    m.low_ask,
    m.discount_pct,
    m.discount_usd,
    m.ask_updated_at,
    m.collection_slug,
    m.collection_name,
    m.render_id,
    m.detail_url,
    m.thumbnail_url,
    m.low_ask_serial,
    m.low_ask_nft_id,
    m.low_confidence_fmv
   FROM public.mv_cross_collection_deals m
  WHERE (m.collection_slug IN ( SELECT c.slug
           FROM public.collections c
          WHERE (c.is_active IS TRUE)))
UNION ALL
 SELECT p.external_id,
    p.name,
    p.player_name,
    p.set_name,
    p.tier,
    p.circulation_count,
    p.fmv_usd,
    p.confidence,
    p.low_ask,
    p.discount_pct,
    p.discount_usd,
    p.ask_updated_at,
    'panini_blockchain'::text AS collection_slug,
    'Panini Blockchain'::text AS collection_name,
    NULL::text AS render_id,
    ('/panini-blockchain/edition/'::text || (p.external_id)::text) AS detail_url,
    p.thumbnail_url,
    p.low_ask_serial,
    NULL::text AS low_ask_nft_id,
    false AS low_confidence_fmv
   FROM public.mv_panini_public_deals_v2 p
  WHERE ('panini_blockchain'::text IN ( SELECT c.slug
           FROM public.collections c
          WHERE (c.is_active IS TRUE)));

ALTER MATERIALIZED VIEW public.mv_panini_public_deals RENAME TO mv_panini_public_deals_retired_20261123;
ALTER INDEX public.mv_panini_public_deals_pk RENAME TO mv_panini_public_deals_retired_20261123_pk;
ALTER MATERIALIZED VIEW public.mv_panini_public_deals_v2 RENAME TO mv_panini_public_deals;
ALTER INDEX public.mv_panini_public_deals_v2_pk RENAME TO mv_panini_public_deals_pk;
