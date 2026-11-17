-- audit_20260919_cross_collection_deals_gets_its_candy_arm
--
-- WHAT. mv_cross_collection_deals is a 3-arm UNION (Top Shot, Disney Pinnacle,
-- NFL All Day) behind the public /insights/deals board. This adds a fourth arm
-- for Candy MLB. The three existing arms are reproduced BYTE-FOR-BYTE from
-- pg_get_viewdef output taken immediately before this migration; the only new
-- SQL is the final UNION ALL block.
--
-- WHY A DROP/CREATE AT ALL: a materialized view has no CREATE OR REPLACE.
-- cross_collection_deals_board depends on it, so that view is dropped and
-- recreated too, with its reloptions and grants re-asserted explicitly (a
-- recreated view does NOT inherit either, and losing security_invoker on a
-- public board is silent).
--
-- ⚠ THE UNIQUE INDEX IS WHY THE NEW ARM IS DISTINCT ON, and this is not a
-- stylistic choice. mv_cross_collection_deals_key is UNIQUE on
-- (collection_slug, external_id) and refresh_cross_collection_deals() runs
-- REFRESH MATERIALIZED VIEW CONCURRENTLY, which REQUIRES that index. The
-- existing arms are all edition-grain; candy_deals_board is LISTING-grain
-- (measured 2026-09-19: 247 rows over 90 editions). A naive UNION of it would
-- duplicate external_id, fail the unique index, and break the concurrent
-- refresh for every collection — not just Candy. DISTINCT ON (external_id)
-- ORDER BY ask_usd ASC takes the cheapest live listing per edition, which is
-- the "floor ask" the other three arms each compute their own way.
--
-- ⭐ candy_deals_board ALREADY EXISTED and is not re-derived here. It keeps a
-- listing only when it is below BOTH the edition FMV and the median sale, and
-- it names the exact copy (token_mint + serial_number) rather than pricing one
-- NFT against another — the grain discipline D33 was filed for. This migration
-- wires it up; it does not rebuild it.
--
-- THE THREE GATES ON THE NEW ARM ARE THE OTHER ARMS' OWN, not new inventions:
--   · confidence IN ('HIGH','MEDIUM') — Top Shot and All Day both require it.
--     candy_deals_board itself does NOT, so without this the board would carry
--     LOW-confidence discounts it applies nowhere else.
--   · low_ask >= 1 — All Day's and Pinnacle's floor. (Top Shot gates at 5; the
--     board's copy already discloses that the minimum is not uniform.)
--   · last_seen_at > now() - interval '3 days' — Pinnacle's freshness gate,
--     `floor_ask_updated_at > now() - '3 days'`.
--
-- 🚨 THE FRESHNESS GATE IS LOAD-BEARING AND IS THE REASON THIS ARM WAS NOT
-- SHIPPED THE OBVIOUS WAY. Candy deactivation is EVIDENCE-BASED, never
-- absence-based -- its indexer's header records the 2026-07-27 incident where
-- an absence-based sweep believed a truncated Magic Eden answer and destroyed
-- 419 standing asks. The only other deactivation path is expiry, and Magic Eden
-- listings carry none: measured 2026-09-19, `expiry IS NULL` on 217 of 217. So
-- a listing whose ending event fell outside the bounded activities walk stays
-- is_active indefinitely -- 217 of 1,997 active Candy listings (10.9%) had not
-- been seen in 7+ days, 216 of them in 30+ days, the oldest 55 days. WITHOUT
-- this gate the board would publish 10 "deals" last observed up to 51 days ago,
-- as live buyable prices, on a public page.
--
-- low_confidence_fmv IS COMPUTED, NOT HARDCODED FALSE. The Top Shot arm reads a
-- dedicated topshot_thin_fmv_editions register; Candy has no equivalent, and
-- emitting a literal `false` would be an assertion ("this FMV is not thin")
-- where the honest content is a measurement. It is derived as sales_count < 8 --
-- the SAME number Pinnacle's arm uses as its inclusion gate
-- (fmv_sales_count_30d >= 8), borrowed rather than invented, and stated here as
-- borrowed. Flagging rather than excluding is deliberate: DealsBoardClient
-- already renders "⚠ thin data — FMV uncertain" for this flag, so the reader
-- sees the row AND the caveat.
--
-- SIZE, measured before applying: 41 editions qualify, average discount 20.8%,
-- max 67.6%, $461.30 of total headroom; every one has >= 5 lifetime sales
-- (avg 46.7), 7 of 41 fall under the thin-FMV flag.
--
-- REVERT (exact): re-run this file with the final `UNION ALL` block (the
-- candy_deals_board arm) deleted, then
--   SELECT public.refresh_cross_collection_deals();
-- Nothing is written outside these two relations and no data is destroyed --
-- the MV is derived and rebuilt from its sources on every refresh.

DROP VIEW IF EXISTS public.cross_collection_deals_board;
DROP MATERIALIZED VIEW IF EXISTS public.mv_cross_collection_deals;

CREATE MATERIALIZED VIEW public.mv_cross_collection_deals AS
 SELECT t.external_id,
    t.name,
    t.player_name,
    t.set_name,
    t.tier::text AS tier,
    t.circulation_count,
    t.fmv_usd,
    t.confidence::text AS confidence,
    t.low_ask,
    t.discount_pct,
    t.discount_usd,
    t.ask_updated_at,
    'nba_top_shot'::text AS collection_slug,
    'NBA Top Shot'::text AS collection_name,
    NULL::text AS render_id,
    '/nba-top-shot/edition/'::text || replace(t.external_id::text, ':'::text, '%3A'::text) AS detail_url,
    NULL::text AS thumbnail_url,
    t.low_ask_serial,
    t.low_ask_nft_id,
    t.low_confidence_fmv
   FROM topshot_deals_vs_fmv t
UNION ALL
 SELECT pc.render_id AS external_id,
    (pc.character_name || ' — '::text) || pc.set_name AS name,
    pc.character_name AS player_name,
    pc.set_name,
    pc.variant AS tier,
    pc.total_minted AS circulation_count,
    pc.fmv_usd,
    pc.fmv_confidence::text AS confidence,
    pc.floor_ask AS low_ask,
    round((pc.fmv_usd - pc.floor_ask) / pc.fmv_usd * 100::numeric, 1) AS discount_pct,
    round(pc.fmv_usd - pc.floor_ask, 2) AS discount_usd,
    pc.floor_ask_updated_at AS ask_updated_at,
    'disney_pinnacle'::text AS collection_slug,
    'Disney Pinnacle'::text AS collection_name,
    pc.render_id,
    '/pinnacle/moment/'::text || pc.render_id AS detail_url,
    '/api/public/pinnacle-image/'::text || pc.render_id AS thumbnail_url,
    NULL::integer AS low_ask_serial,
    NULL::text AS low_ask_nft_id,
    false AS low_confidence_fmv
   FROM pinnacle_catalog pc
  WHERE pc.fmv_usd > 0::numeric AND pc.floor_ask >= 1::numeric AND (pc.fmv_confidence::text = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text])) AND pc.fmv_sales_count_30d >= 8 AND pc.floor_ask_updated_at > (now() - '3 days'::interval) AND pc.floor_ask < pc.fmv_usd
UNION ALL
 SELECT e.external_id,
    e.name,
    e.player_name,
    e.set_name,
    e.tier::text AS tier,
    e.circulation_count,
    f.fmv_usd,
    f.confidence::text AS confidence,
    af.floor_ask AS low_ask,
    round((f.fmv_usd - af.floor_ask) / f.fmv_usd * 100::numeric, 1) AS discount_pct,
    round(f.fmv_usd - af.floor_ask, 2) AS discount_usd,
    af.floor_ask_listed_at AS ask_updated_at,
    'nfl_all_day'::text AS collection_slug,
    'NFL All Day'::text AS collection_name,
    NULL::text AS render_id,
    '/nfl-all-day/edition/'::text || replace(e.external_id::text, ':'::text, '%3A'::text) AS detail_url,
    e.thumbnail_url,
    s.serial_number AS low_ask_serial,
    af.floor_flow_id::text AS low_ask_nft_id,
    false AS low_confidence_fmv
   FROM allday_edition_floor_ask af
     JOIN editions e ON e.id = af.edition_id AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
     JOIN LATERAL ( SELECT fs.fmv_usd,
            fs.confidence
           FROM fmv_snapshots fs
          WHERE fs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND fs.edition_id = e.id AND fs.computed_at <= now()
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON true
     LEFT JOIN allday_moment_serials s ON s.nft_id = af.floor_flow_id::text
  WHERE f.fmv_usd > 0::numeric AND (f.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence])) AND af.floor_ask >= 1::numeric AND af.floor_ask < f.fmv_usd
UNION ALL
 SELECT cd.external_id,
    cd.name,
    cd.player_name,
    cd.set_name,
    cd.tier,
    cd.circulation_count,
    cd.fmv_usd,
    cd.confidence,
    cd.low_ask,
    cd.discount_pct,
    cd.discount_usd,
    cd.ask_updated_at,
    'candy_mlb'::text AS collection_slug,
    'Candy MLB'::text AS collection_name,
    NULL::text AS render_id,
    '/candy-mlb/edition/'::text || cd.external_id AS detail_url,
    cd.thumbnail_url,
    cd.low_ask_serial,
    cd.low_ask_nft_id,
    cd.low_confidence_fmv
   FROM ( SELECT DISTINCT ON (d.external_id) d.external_id::character varying AS external_id,
            e.name,
            d.player_name,
            e.set_name,
            d.tier::text AS tier,
            d.circulation_count,
            d.fmv_usd,
            d.confidence::text AS confidence,
            d.ask_usd AS low_ask,
            d.discount_pct,
            round(d.fmv_usd - d.ask_usd, 2) AS discount_usd,
            d.last_seen_at AS ask_updated_at,
            e.thumbnail_url,
            d.serial_number AS low_ask_serial,
            d.token_mint AS low_ask_nft_id,
            COALESCE(d.sales_count, 0::bigint) < 8 AS low_confidence_fmv
           FROM candy_deals_board d
             JOIN editions e ON e.external_id::text = d.external_id::text AND e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
          WHERE d.fmv_usd > 0::numeric AND (d.confidence = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text])) AND d.ask_usd >= 1::numeric AND d.ask_usd < d.fmv_usd AND d.last_seen_at > (now() - '3 days'::interval)
          ORDER BY d.external_id, d.ask_usd) cd;

CREATE UNIQUE INDEX mv_cross_collection_deals_key ON public.mv_cross_collection_deals USING btree (collection_slug, external_id);

CREATE VIEW public.cross_collection_deals_board WITH (security_invoker = on) AS
 SELECT external_id,
    name,
    player_name,
    set_name,
    tier,
    circulation_count,
    fmv_usd,
    confidence,
    low_ask,
    discount_pct,
    discount_usd,
    ask_updated_at,
    collection_slug,
    collection_name,
    render_id,
    detail_url,
    thumbnail_url,
    low_ask_serial,
    low_ask_nft_id,
    low_confidence_fmv
   FROM mv_cross_collection_deals m
  WHERE (collection_slug IN ( SELECT c.slug
           FROM collections c
          WHERE c.is_active IS TRUE));

GRANT SELECT ON public.cross_collection_deals_board TO anon, authenticated;
