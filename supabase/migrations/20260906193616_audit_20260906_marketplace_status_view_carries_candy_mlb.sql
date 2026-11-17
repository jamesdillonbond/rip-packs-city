-- audit_20260906_marketplace_status_view_carries_candy_mlb
--
-- Found on the live /candy-mlb/overview minutes after the thin launch (real
-- Chromium, 390 px + desktop): the page rendered
--
--   MARKETPLACE STATUS UNCERTAIN — We haven't confirmed an active marketplace
--   venue, so buy flows are disabled.
--
-- because `v_collection_marketplace_status` enumerates the five Flow slugs and
-- `lib/marketplace-status.ts` falls back to `unknown` for anything else. Candy
-- trades daily on Magic Eden (secondary, the registry's `marketplaceMomentUrl`)
-- with OpenSea as a second venue, and `sales` carries 183 `solana_das` rows in
-- the last 24 h — the venue is CONFIRMED, the view simply never asked.
--
-- Why a UNION of a literal row rather than a `collection_config` row: that table
-- is Flow-shaped (NOT NULL `flow_contract_address`, `media_base_url`, tiers) and
-- three Flow read paths iterate it; a Candy row there would be an invitation to
-- index a Solana collection through Cadence. The view is the ONLY consumer of
-- the marketplace facts, so the facts live in the view until a chain-neutral
-- config table exists. `buy_ctas_enabled` stays false: RPC is read-only.
--
-- `security_invoker = true` is RESTATED in the WITH clause — CREATE OR REPLACE
-- VIEW without it resets reloptions (four prior incidents). Column list is
-- unchanged (a UNION cannot rename or reorder).
--
-- Revert: recreate the view from the previous definition (pg_views at
-- 2026-09-06, five-slug WHERE) WITH (security_invoker = true).

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
  WHERE (c.slug)::text = 'candy_mlb';

DO $verify$
DECLARE v_status text; v_opts text[]; v_n int;
BEGIN
  SELECT status INTO v_status FROM public.v_collection_marketplace_status WHERE slug = 'candy_mlb';
  IF v_status IS DISTINCT FROM 'healthy' THEN RAISE EXCEPTION 'candy_mlb status % (expected healthy)', v_status; END IF;
  SELECT count(*) INTO v_n FROM public.v_collection_marketplace_status;
  IF v_n <> 6 THEN RAISE EXCEPTION 'expected 6 rows, got %', v_n; END IF;
  SELECT reloptions INTO v_opts FROM pg_class WHERE relname = 'v_collection_marketplace_status';
  IF NOT ('security_invoker=true' = ANY(v_opts)) THEN RAISE EXCEPTION 'security_invoker was reset: %', v_opts; END IF;
END
$verify$;
