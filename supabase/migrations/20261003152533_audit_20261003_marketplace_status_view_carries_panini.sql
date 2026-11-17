-- audit_20261003_marketplace_status_view_carries_panini
--
-- Found on the live /panini-blockchain/* pages (real Chromium, 1280 px and
-- 390 px, 2026-10-03 ~9:20 AM PT): every Panini surface — overview, market,
-- edition, player — renders
--
--   MARKETPLACE STATUS UNCERTAIN — We haven't confirmed an active marketplace
--   venue, so buy flows are disabled.
--
-- directly above a card that quotes a live "PANINI ASK $30.00". Same defect as
-- 20260906193616 (Candy): `v_collection_marketplace_status` enumerates the
-- five Flow slugs plus a Candy literal row, and `lib/marketplace-status.ts`
-- falls back to `unknown` for anything else. Panini was PUBLISHED 2026-09-25
-- (#64) and the view was never taught the slug. The venue is CONFIRMED, not
-- uncertain: nft.paniniamerica.net is the single native marketplace the walk
-- reads — measured at this write: 86,820 listed serials, 1,758 `panini_sales`
-- in 7 d (15 in the last 24 h, newest 2026-10-03 09:32Z), 12,614
-- `panini_market_board` rows. `buy_ctas_enabled` stays false: RPC is
-- read-only, and the Panini market arm already links the buyer out to
-- Panini's own edition page (ledger 2026-09-25).
--
-- Why a literal UNION row again, not a `collection_config` row: unchanged from
-- the Candy migration — that table is Flow-shaped (NOT NULL contract address,
-- media base, tiers) and three Flow read paths iterate it; Panini is a private
-- permissioned platform with no contract to put there.
--
-- `security_invoker = true` is RESTATED in the WITH clause — CREATE OR REPLACE
-- VIEW without it resets reloptions. Column list unchanged (a UNION cannot
-- rename or reorder). Base asserted before this write: the live definition
-- equalled 20260906193616's body (five-slug WHERE + the Candy row).
--
-- Revert: re-apply the view body from 20260906193616 WITH (security_invoker =
-- true) — the Panini pages then show the "uncertain" banner again.

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
  WHERE ((c.slug)::text = ANY ((ARRAY['nba_top_shot'::character varying, 'nfl_all_day'::character varying, 'disney_pinnacle'::character varying, 'laliga_golazos'::character varying, 'ufc_strike'::character varying])::text[]))
UNION ALL
 SELECT c.id AS collection_id,
    c.slug,
    'healthy'::text AS status,
    false AS buy_ctas_enabled,
    'candy_primary'::text AS primary_venue,
    NULL::text AS primary_contract,
    'magic_eden'::text AS secondary_venue,
    'live'::text AS secondary_status,
    NULL::text AS pack_secondary_venue,
    '2026-09-06 19:30:00+00'::timestamp with time zone AS last_verified_at,
    'Candy MLB (Solana, Metaplex Core). Primary = Candy Digital drops; secondary = Magic Eden (registry marketplaceMomentUrl) with OpenSea as a second venue. Verified 2026-09-06: sales.source solana_das, 183 sales/24h, 6,712 candy_listings. Facts live in this view, not collection_config (Flow-shaped). buy_ctas_enabled=false: RPC is read-only.'::text AS notes
   FROM collections c
  WHERE (c.slug)::text = 'candy_mlb'
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
  WHERE (c.slug)::text = 'panini_blockchain';

DO $verify$
DECLARE v_status text; v_opts text[]; v_n int;
BEGIN
  SELECT status INTO v_status FROM public.v_collection_marketplace_status WHERE slug = 'panini_blockchain';
  IF v_status IS DISTINCT FROM 'healthy' THEN RAISE EXCEPTION 'panini_blockchain status % (expected healthy)', v_status; END IF;
  SELECT status INTO v_status FROM public.v_collection_marketplace_status WHERE slug = 'candy_mlb';
  IF v_status IS DISTINCT FROM 'healthy' THEN RAISE EXCEPTION 'candy_mlb status % (expected healthy)', v_status; END IF;
  SELECT count(*) INTO v_n FROM public.v_collection_marketplace_status;
  IF v_n <> 7 THEN RAISE EXCEPTION 'expected 7 rows, got %', v_n; END IF;
  SELECT reloptions INTO v_opts FROM pg_class WHERE relname = 'v_collection_marketplace_status';
  IF NOT ('security_invoker=true' = ANY(v_opts)) THEN RAISE EXCEPTION 'security_invoker was reset: %', v_opts; END IF;
END
$verify$;
