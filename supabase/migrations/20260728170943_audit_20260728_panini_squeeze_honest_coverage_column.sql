-- audit_20260728_panini_squeeze_honest_coverage_column
--
-- RECOVERED 2026-07-31 (PT) from supabase_migrations.schema_migrations version
-- 20260728170943, verbatim. Applied via Supabase MCP with no repo file and no
-- ledger entry. NOTE: this migration dropped security_invoker as a side effect,
-- repaired minutes later by audit_20260728_panini_squeeze_restore_security_invoker
-- (20260728171010) -- apply the two together, in order.
-- Later superseded by audit_20260728_panini_squeeze_drop_real_sales_contract_half
-- and audit_20260728_panini_squeeze_coverage_weighted_totals.
-- See docs/overnight/ledger.md 2026-07-31.

-- Panini squeeze board: add an honestly-named coverage column alongside real_sales.
--
-- WHY. On 2026-07-28 the board showed fmv_confidence='HIGH' next to real_sales=0
-- on 827 of 3,753 editions (22%) -- avg FMV $270.59, max $48,927.70. Neither value
-- is wrong; they measure DIFFERENT things and sit in adjacent columns, so a reader
-- correctly infers something is broken:
--   * fmv_confidence comes from ms.txns, the upstream marketplace TRANSACTION COUNT
--     (lib/chains/panini/ingest-normalize.ts:53-55 -- txns>=3 HIGH, ==2 MEDIUM, else LOW).
--   * real_sales counts SERIALS carrying a last_sale_usd, and only 5,052 of 29,222
--     serials (17.3%) have one.
-- So the FMV is genuinely sales-backed; real_sales is a serial-level PRICE-COVERAGE
-- measure wearing a market-activity name. /insights/panini-squeeze is a pre-launch
-- surface, so this is fixed BEFORE it is public rather than after.
--
-- EXPAND/CONTRACT, deliberately. real_sales has FOUR live readers, two of them
-- explicit PostgREST select lists that would 400 on an unknown column:
--   app/api/public/insights/panini-squeeze/route.ts:7
--   app/insights/panini-squeeze/page.tsx:11
--   app/insights/panini-squeeze/PaniniSqueezeClient.tsx:18
--   __tests__/api-public-panini-squeeze.test.ts:47
-- This migration is the EXPAND half and is purely additive: the new column is
-- appended last so CREATE OR REPLACE VIEW preserves grants (anon has REFERENCES
-- only, never SELECT) and security_invoker=on. real_sales is left byte-identical,
-- so every existing reader keeps working and nothing renders differently today.
--
-- CONTRACT half is filed as handoff item 4 (docs/handoff-2026-07-28-audit-followups.md):
-- switch those four consumers to serials_with_recorded_price, then DROP real_sales.
-- This column is deliberately unread until that lands. It is NOT orphaned
-- scaffolding (cf. the PANINI_PUBLIC-with-zero-consumers trap found the same day) --
-- if the contract half has not shipped, either finish it or revert this.
--
-- REVERT: CREATE OR REPLACE VIEW public.panini_squeeze_board without the final
-- serials_with_recorded_price column (definition otherwise identical to this one).

CREATE OR REPLACE VIEW public.panini_squeeze_board AS
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
    ( SELECT count(*) AS count
           FROM panini_card_serials cs
          WHERE cs.edition_external_id = e.external_id AND cs.last_sale_usd IS NOT NULL) AS real_sales,
    f.fmv_usd,
    round(e.still_in_packs::numeric * f.fmv_usd) AS sealed_fmv_exposure_usd,
    f.confidence AS fmv_confidence,
    e.serial_low_ask_usd,
    e.thumbnail_url,
    -- Honest name for exactly what real_sales has always computed: the number of
    -- this edition's ingested serials that carry a recorded sale price. It is a
    -- COVERAGE measure, not a market-activity measure, and it does NOT corroborate
    -- fmv_confidence -- see the header note.
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

COMMENT ON VIEW public.panini_squeeze_board IS
 'Panini WC Prizm squeeze board (pre-launch, /insights/panini-squeeze). NOTE: serials_with_recorded_price counts serials with a last_sale_usd (coverage, 17.3% of serials as of 2026-07-28); fmv_confidence derives from the upstream ms.txns transaction count and is NOT corroborated by it. real_sales is a DEPRECATED alias of serials_with_recorded_price, retained only until its four consumers migrate (handoff item 4, 2026-07-28), then dropped.';
