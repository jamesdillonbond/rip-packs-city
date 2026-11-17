-- audit_20260728_panini_squeeze_coverage_weighted_totals
--
-- RECOVERED 2026-07-31 (PT) from supabase_migrations.schema_migrations version
-- 20260728203337, verbatim. Applied via Supabase MCP with no repo file and no
-- ledger entry. Applies AFTER audit_20260728_panini_squeeze_drop_real_sales_contract_half
-- (20260728193043), which is why real_sales is absent from the board definition here.
-- See docs/overnight/ledger.md 2026-07-31.
--
-- Revert: recreate both views from the definitions immediately preceding this
-- migration (board without coverage_flag; totals without the four *_hc / pct
-- columns), then re-ALTER security_invoker=on and re-REVOKE anon on both.

-- Panini squeeze board: expose coverage provenance, and split the headline total.
--
-- WHY. panini_squeeze_totals publishes ONE sealed-dollar figure (~$1.64M). Measured
-- 2026-07-28, 60.6% of it comes from sets flagged 'heavily_biased' -- 36.5% of
-- editions, avg 40.3% checklist completeness, HIGH confidence on only 30% of rows --
-- against 'broad' sets at 41.8% of editions but 19.7% of the dollars and 99% HIGH.
-- The single biggest number a visitor reads is dominated by the weakest data.
--
-- This is structurally the 2026-07-16 chase-biased pack-pool problem, which was
-- solved by refusing to publish a number when the pool is incomplete rather than
-- publishing a confident wrong one. Same precedent applied here.
--
-- WHAT coverage_flag ACTUALLY IS. It is NOT a coverage measurement. Per
-- panini_coverage_audit it is derived entirely from pct_pulled_listed =
-- for_sale_count/pulled_count (>=90 listing_gated, >=25 heavily_biased, >=10 partial,
-- else broad) -- a market ratio used as a proxy for listing-driven discovery bias.
-- It correlates well with the one direct completeness measure available
-- (pct_of_base_checklist: broad 91.1%, heavily_biased 40.3%, partial 19.0%,
-- listing_gated 17.9%) but that measure is only non-null for Base Prizms/Base Choice
-- sets, so the correlation is established on a subset and assumed elsewhere. Treat it
-- as a bias-risk indicator. Do not describe it to users as "coverage".
--
-- PURELY ADDITIVE. Every existing column on both views keeps its name, position and
-- value; new columns are appended last. The single consumer
-- (app/insights/panini-squeeze/page.tsx:74) keeps working unchanged and the board
-- renders identically today. The UI half is filed as a handoff item.
--
-- Join is on (set_name, parallel_family) -- the audit's own GROUP BY grain. Joining
-- on set_name alone double-counts across parallel families.
--
-- THREE MIGRATION TRAPS, all hit for real on this project today:
--   1. CREATE OR REPLACE VIEW does NOT preserve reloptions -> security_invoker is
--      restated via ALTER below for BOTH views.
--   2. CREATE OR REPLACE VIEW cannot drop or reorder columns -- append only.
--   3. A newly created view re-attaches Supabase's default anon grant -> anon is
--      revoked explicitly below and verified after.
--
-- REVERT: recreate both views from the definitions immediately preceding this
-- migration (board without coverage_flag; totals without the four *_hc / pct columns),
-- then re-ALTER security_invoker=on and re-REVOKE anon on both.

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
    f.fmv_usd,
    round(e.still_in_packs::numeric * f.fmv_usd) AS sealed_fmv_exposure_usd,
    f.confidence AS fmv_confidence,
    e.serial_low_ask_usd,
    e.thumbnail_url,
    ( SELECT count(*) AS count
           FROM panini_card_serials cs
          WHERE cs.edition_external_id = e.external_id AND cs.last_sale_usd IS NOT NULL) AS serials_with_recorded_price,
    -- Listing-bias band for this edition's (set_name, parallel_family), from
    -- panini_coverage_audit. 'broad' / 'partial' are the lower-bias bands.
    ca.coverage_flag
   FROM panini_editions e
     LEFT JOIN LATERAL ( SELECT s.fmv_usd,
            s.confidence
           FROM panini_fmv_snapshots s
          WHERE s.edition_id = e.id
          ORDER BY s.computed_at DESC
         LIMIT 1) f ON true
     LEFT JOIN public.panini_coverage_audit ca
            ON ca.set_name = e.set_name
           AND ca.parallel_family IS NOT DISTINCT FROM e.parallel_family
  WHERE e.mint_cap IS NOT NULL;

ALTER VIEW public.panini_squeeze_board SET (security_invoker = on);
REVOKE ALL ON public.panini_squeeze_board FROM anon;

CREATE OR REPLACE VIEW public.panini_squeeze_totals AS
 SELECT count(*) AS editions,
    round(COALESCE(sum(sealed_fmv_exposure_usd), 0::numeric)) AS sealed_fmv_exposure_usd,
    count(*) FILTER (WHERE mint_cap <= 25) AS chases_lte_25,
    COALESCE(sum(still_in_packs), 0::bigint) AS sealed_copies,
    -- ── Honest split, appended 2026-07-28 ───────────────────────────────────────
    -- "hc" = lower-bias bands only (broad + partial). This is the figure to lead
    -- with; the blended sealed_fmv_exposure_usd above is retained unchanged for
    -- back-compat and should NOT be presented as the headline once the UI lands.
    count(*) FILTER (WHERE coverage_flag IN ('broad','partial')) AS editions_hc,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE coverage_flag IN ('broad','partial')), 0::numeric)) AS sealed_fmv_exposure_usd_hc,
    COALESCE(sum(still_in_packs) FILTER (WHERE coverage_flag IN ('broad','partial')), 0::bigint) AS sealed_copies_hc,
    -- Share of the blended sealed-dollar total sourced from the high-bias bands.
    -- This is the number that justifies the split; surface it in methodology copy.
    round(100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE coverage_flag IN ('heavily_biased','listing_gated')), 0::numeric)
          / NULLIF(sum(sealed_fmv_exposure_usd), 0), 1) AS pct_sealed_usd_from_biased_sets
   FROM panini_squeeze_board
  WHERE fmv_usd IS NOT NULL;

ALTER VIEW public.panini_squeeze_totals SET (security_invoker = on);
REVOKE ALL ON public.panini_squeeze_totals FROM anon;

COMMENT ON VIEW public.panini_squeeze_totals IS
 'Panini squeeze headline totals. sealed_fmv_exposure_usd is the BLENDED total across all coverage bands and is retained for back-compat only -- as of 2026-07-28, 60.6%% of it comes from heavily_biased sets. Lead with sealed_fmv_exposure_usd_hc (broad+partial bands). pct_sealed_usd_from_biased_sets quantifies the gap. See claude/panini-coverage-ruling-2026-07-28.md.';
