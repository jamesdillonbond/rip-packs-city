-- audit_20261108_candy_closure_redated_1012
--
-- 2026-11-08 ~7:35 PM PT (Claude Code cloud; Trevor: "Keep going and work through these").
--
-- WHY. v_rpc_trust_health.candy_revival_sales_since_recorded_silence read 3 (BREACH) from the
-- 11-08 7:04 PM PT sentinel on. Those 3 are NOT a revival: they are Candy sales on 2026-10-12 at
-- 5:22 / 5:29 / 7:57 AM PT (solana_das, $0.50-0.55), before Candy's 10-12 NFT lock, ingested
-- 11-08 1:20 PM PT by the new later-set walk. The recorded closure date was one day early: the
-- arm counts sales on or after the day AFTER silent_since_<date>, so 10-11 counted 10-12's sales.
-- No Candy sale after 10-12 7:57 AM PT is recorded (indexer ok at 7:20 PM PT 11-08).
--
-- WHAT CHANGES: the Candy literal row only — secondary_status silent_since_2026_10_11 ->
-- silent_since_2026_10_12, and its notes. last_verified_at is KEPT at 2026-10-28 14:15Z: this is
-- a date correction from our own sales table, not a re-check of Magic Eden, so the 30-day
-- re-verify clock (candy_sales_stale_hours, due ~11-27) is not reset. The two note rows that
-- quote the old literal (sentinel_ingest_watch.candy_mlb, pipeline_zero_yield_suppressions
-- candy-sales-indexer, 20261030173023) are re-worded; nothing matches on the literal.
-- Base asserted: live pg_get_viewdef md5 08227f4e9b8de1d58763505b88d2f4c4 (read 11-08 7:24 PM PT);
-- body = 20261028141905's minus the three Candy literals. security_invoker RESTATED; columns,
-- order and grants unchanged.
--
-- Revert: re-apply the view from 20261028141905 (WITH security_invoker = true); restore the
-- two notes from 20261030173023.

DO $premise$
BEGIN
  IF md5(pg_get_viewdef('public.v_collection_marketplace_status'::regclass)) <> '08227f4e9b8de1d58763505b88d2f4c4' THEN
    RAISE EXCEPTION 'premise: v_collection_marketplace_status changed since read; re-read before replacing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales
              WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
                AND sold_at >= timestamptz '2026-10-13 07:00:00+00') THEN
    RAISE EXCEPTION 'premise: Candy has traded after 10-12 PT; this is a revival, re-verify instead';
  END IF;
END
$premise$;

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
    'silent_since_2026_10_12'::text AS secondary_status,
    NULL::text AS pack_secondary_venue,
    '2026-10-28 14:15:00+00'::timestamp with time zone AS last_verified_at,
    'Candy MLB (Solana, Metaplex Core). Primary = Candy Digital drops; secondary = Magic Eden (registry marketplaceMomentUrl). Re-verified 2026-10-28 (PT): candy-sales-indexer 8 of 8 runs ok in 24 h, 0 unresolved. Secondary trading STOPPED rather than moving venues (2026-10-25 Solana collection census, #58), so no OpenSea feed is needed. RE-DATED 2026-11-08 (PT): the newest indexed sale is 2026-10-12 7:57 AM PT (three sales 10-12 5:22 / 5:29 / 7:57 AM PT, before Candy''s 10-12 NFT lock, found late by the 11-08 later-set walk), so the silence starts 10-12, not 10-11; last_verified_at is NOT advanced by that correction. A new sale trips v_rpc_trust_health.candy_revival_sales_since_recorded_silence; re-verify this row then. Facts live in this view, not collection_config (Flow-shaped). buy_ctas_enabled=false: RPC is read-only.'::text AS notes
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

ALTER VIEW public.v_collection_marketplace_status SET (security_invoker = true);

UPDATE public.sentinel_ingest_watch
   SET note = 'RECORDED SILENCE, not an ingest fault (2026-10-29; re-dated 2026-11-08): v_collection_marketplace_status.candy_mlb.secondary_status = silent_since_2026_10_12 (#58). Revival pages via v_rpc_trust_health.candy_revival_sales_since_recorded_silence on the first sale; set loudness back to warn then.'
 WHERE collection_key = 'candy_mlb' AND loudness = 'off';

UPDATE public.pipeline_zero_yield_suppressions
   SET reason = 'RECORDED SILENCE, measured 2026-10-29 ~9:40 AM PT; re-dated 2026-11-08. Candy secondary trading stopped on 2026-10-12 (newest sale 7:57 AM PT, #58); v_collection_marketplace_status.candy_mlb.secondary_status = silent_since_2026_10_12. The indexer runs ok, so "found nothing" is the market, not the lane. RE-CHECK CONDITION: remove this row when candy_revival_sales_since_recorded_silence > 0 (Candy traded again), when secondary_status changes to anything but a silent_since date, or if the indexer stops logging ok runs.'
 WHERE pipeline = 'candy-sales-indexer';
