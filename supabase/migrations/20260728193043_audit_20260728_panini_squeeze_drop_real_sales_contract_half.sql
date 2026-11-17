-- audit_20260728_panini_squeeze_drop_real_sales_contract_half
--
-- CONTRACT half of the expand/contract rename started by
-- audit_20260728_panini_squeeze_honest_coverage_column (which ADDED
-- serials_with_recorded_price alongside real_sales).
--
-- WHY: real_sales has always counted serial-level PRICE COVERAGE (serials carrying a
-- last_sale_usd -- only ~17.3% of ingested serials have one), never market activity,
-- while the adjacent fmv_confidence derives from the upstream marketplace txn count
-- (ms.txns). Two different quantities in neighbouring columns read as corroborating,
-- which is why 840 editions advertised fmv_confidence=HIGH beside real_sales=0.
-- Renamed, NOT re-sourced: ms.txns is discarded at ingest today and is not available
-- to this view.
--
-- SAFE: the two columns are literally the same subquery; verified 0 mismatches across
-- all 3,774 rows immediately before this migration. All four code consumers were
-- already cut over and deployed (8e53b936, dpl_Dk2MxThs63BT1h7LDEhr7ZUorN87 READY).
--
-- CREATE OR REPLACE VIEW cannot DROP a column, so this is DROP + CREATE. Two
-- consequences handled explicitly below:
--   1. panini_squeeze_totals depends on the board and must be recreated.
--   2. A newly-created view picks up Supabase's DEFAULT anon/authenticated grant, so
--      the revoke is re-asserted. Pre-state ACL was postgres + service_role only
--      (anon held REFERENCES/MAINTAIN, never SELECT) and must be restored exactly.
--   3. reloptions are NOT preserved -- security_invoker=on is restated inline.
--
-- REVERT: recreate both views with the `real_sales` column restored immediately before
-- `f.fmv_usd` in the board's select list (definition otherwise identical to below),
-- re-assert WITH (security_invoker=on) on both, then re-run the REVOKE/GRANT block.

DROP VIEW IF EXISTS public.panini_squeeze_totals;
DROP VIEW IF EXISTS public.panini_squeeze_board;

CREATE VIEW public.panini_squeeze_board
WITH (security_invoker = on) AS
 SELECT e.id,
    e.external_id,
    e.collection_id,
    e.player_name,
    e.nation,
    e.set_name,
    e.parallel,
    e.parallel_family,
    e.rarity_label,
    e.tier,
    e.mint_cap,
    e.pulled_count,
    e.still_in_packs,
        CASE
            WHEN COALESCE(e.mint_cap, 0) > 0 THEN round(e.pulled_count::numeric / e.mint_cap::numeric * 100::numeric, 1)
            ELSE NULL::numeric
        END AS rip_pct,
    e.is_fotl_exclusive,
    (EXISTS ( SELECT 1
           FROM panini_card_serials cs
          WHERE cs.edition_external_id = e.external_id AND cs.nft_type ~~ '%rookie card%'::text)) AS is_rookie,
    (EXISTS ( SELECT 1
           FROM panini_card_serials cs
          WHERE cs.edition_external_id = e.external_id AND cs.nft_type ~~ '%debut card%'::text)) AS is_debut,
    f.fmv_usd,
    round(e.still_in_packs::numeric * f.fmv_usd) AS sealed_fmv_exposure_usd,
    f.confidence AS fmv_confidence,
    e.serial_low_ask_usd,
    e.thumbnail_url,
    ( SELECT count(*) AS count
           FROM panini_card_serials cs
          WHERE cs.edition_external_id = e.external_id AND cs.last_sale_usd IS NOT NULL) AS serials_with_recorded_price
   FROM panini_editions e
     LEFT JOIN LATERAL ( SELECT s.fmv_usd,
            s.confidence
           FROM panini_fmv_snapshots s
          WHERE s.edition_id = e.id
          ORDER BY s.computed_at DESC
         LIMIT 1) f ON true
  WHERE e.mint_cap IS NOT NULL;

CREATE VIEW public.panini_squeeze_totals
WITH (security_invoker = on) AS
 SELECT count(*) AS editions,
    round(COALESCE(sum(sealed_fmv_exposure_usd), 0::numeric)) AS sealed_fmv_exposure_usd,
    count(*) FILTER (WHERE mint_cap <= 25) AS chases_lte_25,
    COALESCE(sum(still_in_packs), 0::bigint) AS sealed_copies
   FROM panini_squeeze_board
  WHERE fmv_usd IS NOT NULL;

-- Panini is pre-launch and route-gated in proxy.ts, but route-gating is NOT data-gating:
-- without this the tables would be queryable at /rest/v1/<view> with the public anon key.
REVOKE ALL ON public.panini_squeeze_board FROM anon, authenticated;
REVOKE ALL ON public.panini_squeeze_totals FROM anon, authenticated;
GRANT SELECT ON public.panini_squeeze_board TO service_role;
GRANT SELECT ON public.panini_squeeze_totals TO service_role;

COMMENT ON VIEW public.panini_squeeze_board IS
  'Panini WC Prizm squeeze board. serials_with_recorded_price counts serial-level PRICE COVERAGE (serials carrying last_sale_usd), NOT market activity -- it is unrelated to fmv_confidence, which derives from the upstream marketplace txn count. Renamed from real_sales 2026-07-28.';