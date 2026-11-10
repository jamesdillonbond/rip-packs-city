-- audit_20261110_candy_marketplace_silence_reverified
--
-- Cowork applies this (dashboard SQL editor); Claude Code's apply_migration prompt times out unanswered.
-- WHY: trust arm candy_revival_sales_since_recorded_silence = 1 (breach 1) since a $0.17 Magic Eden sale on 11-09. The arm
-- asks for exactly this: re-look at Candy trading and update the candy_mlb row of v_collection_marketplace_status. Measured
-- 2:50 PM PT 11-10: sales since 10-13 = 1 recorded ($0.17, 11-09) + 4 parked dust (11-07, 11-08; 0.034 SOL). A trickle,
-- not a revival -> re-date silent_since to 2026-11-10 and advance last_verified_at. Only the candy_mlb literals change;
-- the rest is the live definition verbatim (md5 cb6fa6c9f9a6da15fe34874ac288bab8, asserted). security_invoker kept;
-- CREATE OR REPLACE VIEW keeps the ACL.
-- REVERT: re-run with the three literals restored ('silent_since_2026_10_12', '2026-10-28 14:15:00+00', the old notes).

DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_collection_marketplace_status'::regclass, true)) <> 'cb6fa6c9f9a6da15fe34874ac288bab8' THEN
    RAISE EXCEPTION 'v_collection_marketplace_status drifted from the 2:50 PM PT 11-10 definition; re-read before replacing';
  END IF;
END $$;

CREATE OR REPLACE VIEW public.v_collection_marketplace_status WITH (security_invoker = true) AS
 SELECT c.id AS collection_id,
    c.slug,
    cc.metadata #>> '{marketplace,status}'::text[] AS status,
    (cc.metadata #>> '{marketplace,buy_ctas_enabled}'::text[])::boolean AS buy_ctas_enabled,
    cc.metadata #>> '{marketplace,primary_venue}'::text[] AS primary_venue,
    cc.metadata #>> '{marketplace,primary_contract}'::text[] AS primary_contract,
    cc.metadata #>> '{marketplace,secondary_venue}'::text[] AS secondary_venue,
    cc.metadata #>> '{marketplace,secondary_status}'::text[] AS secondary_status,
    cc.metadata #>> '{marketplace,pack_secondary_venue}'::text[] AS pack_secondary_venue,
    (cc.metadata #>> '{marketplace,last_verified_at}'::text[])::timestamp with time zone AS last_verified_at,
    cc.metadata #>> '{marketplace,notes}'::text[] AS notes
   FROM collection_config cc
     JOIN collections c ON c.id = cc.collection_id
  WHERE c.slug::text = ANY (ARRAY['nba_top_shot'::character varying::text, 'nfl_all_day'::character varying::text, 'disney_pinnacle'::character varying::text, 'laliga_golazos'::character varying::text, 'ufc_strike'::character varying::text])
UNION ALL
 SELECT c.id AS collection_id,
    c.slug,
    'healthy'::text AS status,
    false AS buy_ctas_enabled,
    'candy_primary'::text AS primary_venue,
    NULL::text AS primary_contract,
    'magic_eden'::text AS secondary_venue,
    'silent_since_2026_11_10'::text AS secondary_status,
    NULL::text AS pack_secondary_venue,
    '2026-11-10 22:55:00+00'::timestamp with time zone AS last_verified_at,
    'Candy MLB (Solana, Metaplex Core). Primary = Candy Digital drops; secondary = Magic Eden (registry marketplaceMomentUrl). Re-verified 2026-10-28 (PT): candy-sales-indexer 8 of 8 runs ok in 24 h, 0 unresolved. Secondary trading STOPPED rather than moving venues (2026-10-25 Solana collection census, #58), so no OpenSea feed is needed. RE-DATED 2026-11-08 (PT): the newest indexed sale is 2026-10-12 7:57 AM PT (three sales 10-12 5:22 / 5:29 / 7:57 AM PT, before Candy''s 10-12 NFT lock, found late by the 11-08 later-set walk), so the silence starts 10-12, not 10-11; last_verified_at is NOT advanced by that correction. A new sale trips v_rpc_trust_health.candy_revival_sales_since_recorded_silence; re-verify this row then. RE-VERIFIED + RE-DATED 2026-11-10 (PT, Claude Code cloud; applied by Cowork): the revival arm fired on ONE Magic Eden sale of $0.17 on 11-09; with it, 4 dust sales (11-07 x3, 11-08; 0.034 SOL, ~$3 total) were parked no_sol_rate. 5 sales / ~$3 in 4 weeks is a trickle, not a revived market, so the silence is re-dated to 11-10 and last_verified_at advanced; a sale on 11-11 or later trips the arm again. Facts live in this view, not collection_config (Flow-shaped). buy_ctas_enabled=false: RPC is read-only.'::text AS notes
   FROM collections c
  WHERE c.slug::text = 'candy_mlb'::text
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
  WHERE c.slug::text = 'panini_blockchain'::text;
