-- audit_20261023_marketplace_status_candy_row_silent_since_1011
--
-- 2026-10-23 ~10:50 PM PT (Claude Code cloud; Trevor: "Do all you can").
-- `v_collection_marketplace_status` hardcodes the Candy MLB row in the view
-- body (20260906193616): secondary_status 'live', notes "Verified 2026-09-06:
-- ... 183 sales/24h". Measured at this write: the newest Candy sale in `sales`
-- is 2026-10-12 03:21:04Z (10-11 8:21 PM PT) and 0 rows have landed since,
-- 41 in the 14 days to it. Whether that is a market-wide freeze or a venue
-- move (OpenSea) is #58, and it is open until OPENSEA_API_KEY is set. So the
-- row stops claiming "live" and says what is measured.
--
-- WHAT CHANGES: the Candy literal row only. secondary_status 'live' ->
-- 'silent_since_2026_10_11', last_verified_at stamped, notes rewritten.
-- ⚠ status stays 'healthy' and buy_ctas_enabled stays false, so NOTHING on
-- screen moves (lib/marketplace-status.ts consumers render status /
-- buy_ctas_enabled only). ⚠ Deliberately NOT a 'dormant_*' value: the
-- FlowtyDormancyChip keys on startsWith("dormant") and hardcodes a Flowty
-- message (same reason as 20261018041800's Golazos value).
--
-- Base asserted before this write: the live pg_get_viewdef equalled the body
-- below except the three Candy literals (md5 aab4a8cd58e30883eb95e5b2ba6cd360
-- at read). The Flow arm reads collection_config, so the Golazos row's own
-- 10-23 correction is untouched by this replace.
-- `security_invoker = true` is RESTATED — CREATE OR REPLACE VIEW without it
-- resets reloptions. Column list and order unchanged. Grants carry over on a
-- replace (authenticated SELECT, service_role, postgres — checked at read).
--
-- Revert: re-apply the view body from 20261003152533 WITH (security_invoker = true).

CREATE OR REPLACE VIEW public.v_collection_marketplace_status
WITH (security_invoker = true) AS
 SELECT c.id AS collection_id,
    c.slug,
    (cc.metadata #>> '{marketplace,status}'::text[]) AS status,
    ((cc.metadata #>> '{marketplace,buy_ctas_enabled}'::text[]))::boolean AS buy_ctas_enabled,
    (cc.metadata #>> '{marketplace,primary_venue}'::text[]) AS primary_venue,
    (cc.metadata #>> '{marketplace,primary_contract}'::text[]) AS primary_contract,
    (cc.metadata #>> '{marketplace,secondary_venue}'::text[]) AS secondary_venue,
    (cc.metadata #>> '{marketplace,secondary_status}'::text[]) AS secondary_status,
    (cc.metadata #>> '{marketplace,pack_secondary_venue}'::text[]) AS pack_secondary_venue,
    ((cc.metadata #>> '{marketplace,last_verified_at}'::text[]))::timestamp with time zone AS last_verified_at,
    (cc.metadata #>> '{marketplace,notes}'::text[]) AS notes
   FROM (collection_config cc
     JOIN collections c ON ((c.id = cc.collection_id)))
  WHERE ((c.slug)::text = ANY (ARRAY[('nba_top_shot'::character varying)::text, ('nfl_all_day'::character varying)::text, ('disney_pinnacle'::character varying)::text, ('laliga_golazos'::character varying)::text, ('ufc_strike'::character varying)::text]))
UNION ALL
 SELECT c.id AS collection_id,
    c.slug,
    'healthy'::text AS status,
    false AS buy_ctas_enabled,
    'candy_primary'::text AS primary_venue,
    NULL::text AS primary_contract,
    'magic_eden'::text AS secondary_venue,
    'silent_since_2026_10_11'::text AS secondary_status,
    NULL::text AS pack_secondary_venue,
    '2026-10-24 05:41:00+00'::timestamp with time zone AS last_verified_at,
    'Candy MLB (Solana, Metaplex Core). Primary = Candy Digital drops; secondary = Magic Eden (registry marketplaceMomentUrl) with OpenSea as a second venue. Re-verified 2026-10-23 (PT): newest indexed sale 2026-10-11 8:21 PM PT (sales.source solana_das), 0 since; 41 in the 14 days to it. Freeze vs venue move is unresolved until OPENSEA_API_KEY is set (#58). Facts live in this view, not collection_config (Flow-shaped). buy_ctas_enabled=false: RPC is read-only.'::text AS notes
   FROM collections c
  WHERE ((c.slug)::text = 'candy_mlb'::text)
UNION ALL
 SELECT c.id AS collection_id,
    c.slug,
    'healthy'::text AS status,
    false AS buy_ctas_enabled,
    'panini_native'::text AS primary_venue,
    NULL::text AS primary_contract,
    NULL::text AS secondary_venue,
    NULL::text AS secondary_status,
    NULL::text AS pack_secondary_venue,
    '2026-10-03 16:20:00+00'::timestamp with time zone AS last_verified_at,
    'Panini Blockchain (private permissioned platform, nft.paniniamerica.net). Primary = Panini''s own marketplace, the single venue the residential walk reads; no secondary venue (the OpenSea Ethereum bridge carries no Panini cards RPC holds — #64). Verified 2026-10-03: 86,820 listed serials, 1,758 panini_sales in 7 d, 12,614 panini_market_board rows. Facts live in this view, not collection_config (Flow-shaped). buy_ctas_enabled=false: RPC is read-only; the market arm links out to Panini''s edition page.'::text AS notes
   FROM collections c
  WHERE ((c.slug)::text = 'panini_blockchain'::text);
