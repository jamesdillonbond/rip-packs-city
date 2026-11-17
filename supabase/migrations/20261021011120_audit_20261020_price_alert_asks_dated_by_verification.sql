-- audit_20261020_price_alert_asks_dated_by_verification
--
-- 2026-10-20 (Claude Code cloud), ~6:20 PM PT. Follow-on to 20261021003446 / 20261021004010, and a fix to
-- a gap those two left: edition_current_ask (the price-only alert pool, read by dispatch_due_deal_alerts and
-- build_deal_alerts_for_subscription) still published floor_ask_listed_at as ask_updated_at on its All Day
-- and Golazos arms. Since those two collections' askStampKind became "checked", lib/alerts/format.ts words
-- that stamp "ask seen 90d ago — may be gone": a posting date presented as a check. No alert delivery was
-- written between the code deploy (~5:48 PM PT) and this fix (alert_deliveries since 00:34Z: 0).
--
-- WHAT. The All Day and Golazos arms read floor_ask_verified_at. Every other token is pg_get_viewdef of the
-- live view taken immediately before (md5 fb55dbe19bb4c7bb13727ced743498fd). The live body was last
-- written by a dynamic EXECUTE in 20261001030000, so this file is also the first literal copy of it since
-- 20260816161500.
--
-- ALERT FIRING IS UNCHANGED: ask_is_alertable() exempts 'nfl_all_day' and 'laliga_golazos' from its age
-- gate (it returns true for them whatever p_ask_at is). Its comment ("the stamp is the seller's listing
-- date") is now stale; the exemption itself stays right, because All Day V1 asks are re-verified only
-- weekly (#198) and a 12 h gate would silence correct alerts.
--
-- security_invoker re-asserted (CREATE OR REPLACE VIEW resets reloptions); grants are kept by REPLACE.
-- REVERT: re-run this file with floor_ask_verified_at -> floor_ask_listed_at on the two arms (and revert
-- askStampKind for those collections in lib/market/ask-freshness.ts).

CREATE OR REPLACE VIEW public.edition_current_ask WITH (security_invoker = on) AS
 SELECT (e.external_id)::text AS external_id,
    (e.name)::text AS name,
    e.player_name,
    e.set_name,
    (e.tier)::text AS tier,
    e.circulation_count,
    NULL::numeric AS fmv_usd,
    NULL::text AS confidence,
    eo.low_ask,
    NULL::numeric AS discount_pct,
    NULL::numeric AS discount_usd,
    eo.low_ask_confirmed_at AS ask_updated_at,
    'nba_top_shot'::text AS collection_slug,
    'NBA Top Shot'::text AS collection_name,
    NULL::text AS render_id,
    ('/nba-top-shot/edition/'::text || replace((e.external_id)::text, ':'::text, '%3A'::text)) AS detail_url,
    e.thumbnail_url,
    eo.low_ask_serial,
    eo.low_ask_nft_id,
    false AS low_confidence_fmv
   FROM (edition_offers eo
     JOIN editions e ON ((((e.external_id)::text = eo.external_id) AND (e.collection_id = eo.collection_id))))
  WHERE ((eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid) AND (eo.low_ask > (0)::numeric) AND ((e.external_id)::text ~ '^[0-9]+:[0-9]+'::text))
UNION ALL
 SELECT (e.external_id)::text AS external_id,
    (e.name)::text AS name,
    e.player_name,
    e.set_name,
    (e.tier)::text AS tier,
    e.circulation_count,
    NULL::numeric AS fmv_usd,
    NULL::text AS confidence,
    af.floor_ask AS low_ask,
    NULL::numeric AS discount_pct,
    NULL::numeric AS discount_usd,
    af.floor_ask_verified_at AS ask_updated_at,
    'nfl_all_day'::text AS collection_slug,
    'NFL All Day'::text AS collection_name,
    NULL::text AS render_id,
    ('/nfl-all-day/edition/'::text || replace((e.external_id)::text, ':'::text, '%3A'::text)) AS detail_url,
    e.thumbnail_url,
    NULL::integer AS low_ask_serial,
    (af.floor_flow_id)::text AS low_ask_nft_id,
    false AS low_confidence_fmv
   FROM (allday_edition_floor_ask af
     JOIN editions e ON (((e.id = af.edition_id) AND (e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid))))
  WHERE (af.floor_ask > (0)::numeric)
UNION ALL
 SELECT (e.external_id)::text AS external_id,
    (e.name)::text AS name,
    e.player_name,
    e.set_name,
    (e.tier)::text AS tier,
    e.circulation_count,
    NULL::numeric AS fmv_usd,
    NULL::text AS confidence,
    gf.floor_ask AS low_ask,
    NULL::numeric AS discount_pct,
    NULL::numeric AS discount_usd,
    gf.floor_ask_verified_at AS ask_updated_at,
    'laliga_golazos'::text AS collection_slug,
    'LaLiga Golazos'::text AS collection_name,
    NULL::text AS render_id,
    ('/laliga-golazos/edition/'::text || replace((e.external_id)::text, ':'::text, '%3A'::text)) AS detail_url,
    e.thumbnail_url,
    NULL::integer AS low_ask_serial,
    (gf.floor_flow_id)::text AS low_ask_nft_id,
    false AS low_confidence_fmv
   FROM (golazos_edition_floor_ask gf
     JOIN editions e ON (((e.id = gf.edition_id) AND (e.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid))))
  WHERE (gf.floor_ask > (0)::numeric)
UNION ALL
 SELECT pc.render_id AS external_id,
    ((pc.character_name || ' — '::text) || pc.set_name) AS name,
    pc.character_name AS player_name,
    pc.set_name,
    pc.variant AS tier,
    pc.total_minted AS circulation_count,
    NULL::numeric AS fmv_usd,
    NULL::text AS confidence,
    pc.floor_ask AS low_ask,
    NULL::numeric AS discount_pct,
    NULL::numeric AS discount_usd,
    pc.floor_ask_updated_at AS ask_updated_at,
    'disney_pinnacle'::text AS collection_slug,
    'Disney Pinnacle'::text AS collection_name,
    pc.render_id,
    ('/pinnacle/moment/'::text || pc.render_id) AS detail_url,
    ('/api/public/pinnacle-image/'::text || pc.render_id) AS thumbnail_url,
    NULL::integer AS low_ask_serial,
    NULL::text AS low_ask_nft_id,
    false AS low_confidence_fmv
   FROM pinnacle_catalog pc
  WHERE (pc.floor_ask > (0)::numeric);
