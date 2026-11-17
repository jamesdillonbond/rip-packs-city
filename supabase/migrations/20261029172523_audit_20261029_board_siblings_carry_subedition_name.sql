-- audit_20261029_board_siblings_carry_subedition_name — 2026-10-29 10:25 AM PT applied (Claude Code cloud).
--
-- 20261029172325 appended subedition_name to five Top Shot boards. Three of those boards share ONE
-- select list with a sibling view per collection (lib/insights/squeeze-board.ts SQUEEZE_COLS,
-- lib/serial-premiums-board.ts SHARED_COLS, lib/insights/top-sales.ts SELECT_COLS), so the column
-- has to exist on every sibling before the code can select it. Each sibling below appends the same
-- column: editions.subedition_name where the view joins editions, and NULL::text for Pinnacle top
-- sales (no editions row; a pin's variant is already its tier).
--
-- Guarded by viewdef md5, security_invoker=on restated, and post-flight asserts the +1 column count.
-- REVERT: DROP + re-CREATE each without the last column (bodies below minus that line), restating
-- security_invoker=on and the existing grants.

DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.allday_squeeze_board'::regclass)) <> '5c0aa2e6035ec9a13cccb49f50cb1a60'
     OR md5(pg_get_viewdef('public.allday_serial_premiums_board'::regclass)) <> '7c712bbea1606b2840f7d6077ee53415'
     OR md5(pg_get_viewdef('public.allday_perfect_mint_premiums_board'::regclass)) <> '91c03bb35a993e41fea266dcaf48949c'
     OR md5(pg_get_viewdef('public.v_panini_top_sales'::regclass)) <> 'e455f69624d77a9e41be93f133182694'
     OR md5(pg_get_viewdef('public.v_pinnacle_top_sales'::regclass)) <> '3917a1faa49f5dcdf8e8930568581ba2' THEN
    RAISE EXCEPTION 'a sibling board view changed since 2026-10-29 ~10:25 AM PT; re-read it';
  END IF;
END
$guard$;

CREATE OR REPLACE VIEW public.allday_squeeze_board WITH (security_invoker = on) AS
 SELECT e.id AS edition_id,
    e.external_id,
    COALESCE(e.player_name, be.player_name) AS player_name,
    COALESCE(e.set_name, be.set_name) AS set_name,
    COALESCE(e.tier::text, replace(be.tier, 'MOMENT_TIER_'::text, ''::text)) AS tier,
    c.circ AS circulation,
    be.locked,
    be.burned,
    round(100.0 * be.locked::numeric / c.circ::numeric, 1) AS lock_pct,
    round(100.0 * be.burned::numeric / c.circ::numeric, 1) AS burn_pct,
    round(100.0 * (be.locked + be.burned)::numeric / c.circ::numeric, 1) AS squeeze_pct,
    GREATEST(c.circ - be.locked - be.burned, 0) AS effectively_buyable,
    fa.floor_ask AS low_ask,
    efc.fmv_usd::numeric(12,4) AS fmv_usd,
    efc.confidence::text AS confidence,
    e.game_date,
    e.thumbnail_url,
    efc.fmv_usd IS NOT NULL AND efc.fmv_usd > 0::numeric AND fa.floor_ask IS NOT NULL AND fa.floor_ask > (10::numeric * efc.fmv_usd) AS low_ask_disconnected,
    e.set_id,
    e.team_name,
    NULL::numeric AS top5_share_pct,
    NULL::integer AS holders,
    e.subedition_name
   FROM badge_editions be
     JOIN editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
     CROSS JOIN LATERAL ( SELECT COALESCE(e.circulation_count, be.circulation_count) AS circ) c
     LEFT JOIN allday_edition_floor_ask fa ON fa.edition_id = e.id
     LEFT JOIN edition_fmv_current efc ON efc.edition_id = e.id
  WHERE be.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND be.locked IS NOT NULL AND be.burned IS NOT NULL AND c.circ IS NOT NULL AND c.circ > 0;

CREATE OR REPLACE VIEW public.allday_serial_premiums_board WITH (security_invoker = on) AS
 WITH no1 AS (
         SELECT DISTINCT ON (s.edition_id) s.edition_id,
            s.price_usd AS no1_price,
            s.sold_at AS no1_sold_at,
            s.moment_id,
            s.nft_id
           FROM sales s
          WHERE s.collection = 'nfl_all_day'::text AND s.serial_number = 1 AND s.sold_at >= (now() - '90 days'::interval) AND s.price_usd > 0::numeric
          ORDER BY s.edition_id, s.sold_at DESC
        ), ed_med AS (
         SELECT s.edition_id,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision)) AS edition_median,
            count(*) AS edition_sales_180d
           FROM sales s
          WHERE s.collection = 'nfl_all_day'::text AND s.sold_at >= (now() - '180 days'::interval) AND s.price_usd > 0::numeric AND (s.edition_id IN ( SELECT no1.edition_id
                   FROM no1))
          GROUP BY s.edition_id
         HAVING count(*) >= 15
        )
 SELECT e.id AS edition_id,
    e.external_id,
    e.player_name,
    e.set_name,
    e.tier::text AS tier,
    e.circulation_count,
    e.thumbnail_url,
    n.moment_id,
    n.nft_id,
    round(m.edition_median::numeric, 2) AS edition_median_usd,
    round(n.no1_price::numeric, 2) AS no1_last_sale_usd,
    round((n.no1_price::double precision / m.edition_median)::numeric, 1) AS premium_multiple,
    n.no1_sold_at,
    m.edition_sales_180d,
    false AS is_conflated,
    e.subedition_name
   FROM no1 n
     JOIN ed_med m ON m.edition_id = n.edition_id
     JOIN editions e ON e.id = n.edition_id
  WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND e.thumbnail_url IS NOT NULL AND m.edition_median >= 0.10::double precision AND (n.no1_price::double precision / m.edition_median) >= 5::double precision
  ORDER BY (n.no1_price::double precision / m.edition_median) DESC;

CREATE OR REPLACE VIEW public.allday_perfect_mint_premiums_board WITH (security_invoker = on) AS
 WITH perfect AS (
         SELECT DISTINCT ON (s.edition_id) s.edition_id,
            s.price_usd AS perfect_price,
            s.sold_at AS perfect_sold_at,
            s.moment_id,
            s.nft_id,
            s.serial_number
           FROM sales s
             JOIN editions e2 ON e2.id = s.edition_id
          WHERE s.collection = 'nfl_all_day'::text AND e2.circulation_count > 1 AND s.serial_number = e2.circulation_count AND s.sold_at >= (now() - '90 days'::interval) AND s.price_usd > 0::numeric AND NOT (EXISTS ( SELECT 1
                   FROM sales s3
                  WHERE s3.edition_id = s.edition_id AND s3.collection = 'nfl_all_day'::text AND s3.serial_number > e2.circulation_count))
          ORDER BY s.edition_id, s.sold_at DESC
        ), ed_med AS (
         SELECT s.edition_id,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision)) AS edition_median,
            count(*) AS edition_sales_180d
           FROM sales s
          WHERE s.collection = 'nfl_all_day'::text AND s.sold_at >= (now() - '180 days'::interval) AND s.price_usd > 0::numeric AND (s.edition_id IN ( SELECT perfect.edition_id
                   FROM perfect))
          GROUP BY s.edition_id
         HAVING count(*) >= 15
        )
 SELECT e.id AS edition_id,
    e.external_id,
    e.player_name,
    e.set_name,
    e.tier::text AS tier,
    e.circulation_count,
    e.thumbnail_url,
    p.moment_id,
    p.nft_id,
    p.serial_number AS perfect_serial,
    round(m.edition_median::numeric, 2) AS edition_median_usd,
    round(p.perfect_price::numeric, 2) AS perfect_last_sale_usd,
    round((p.perfect_price::double precision / m.edition_median)::numeric, 1) AS premium_multiple,
    p.perfect_sold_at,
    m.edition_sales_180d,
    false AS is_conflated,
    e.subedition_name
   FROM perfect p
     JOIN ed_med m ON m.edition_id = p.edition_id
     JOIN editions e ON e.id = p.edition_id
  WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND e.thumbnail_url IS NOT NULL AND m.edition_median >= 0.10::double precision AND (p.perfect_price::double precision / m.edition_median) >= 5::double precision
  ORDER BY (p.perfect_price::double precision / m.edition_median) DESC;

CREATE OR REPLACE VIEW public.v_panini_top_sales WITH (security_invoker = on) AS
 SELECT md5((ps.sku || '|'::text) || ps.sold_at::text)::uuid AS sale_id,
    e.id AS edition_id,
    e.external_id,
    'panini_blockchain'::text AS collection,
    e.collection_id,
    e.player_name,
    e.set_name,
    e.team_name,
    e.tier,
    e.circulation_count,
    e.thumbnail_url,
    NULL::uuid AS moment_id,
    NULL::text AS nft_id,
    "substring"(ps.sku, '__([0-9]+)_[0-9]+$'::text)::integer AS serial_number,
    ps.amount_usd AS price_usd,
    ps.sold_at,
    ps.buyer AS buyer_address,
    ps.seller AS seller_address,
    'panini'::text AS marketplace,
    e.subedition_name
   FROM panini_sales ps
     JOIN editions e ON e.external_id::text = ps.edition_external_id AND e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
  WHERE ps.amount_usd >= 100::numeric AND ps.sold_at >= (now() - '30 days'::interval) AND e.thumbnail_url IS NOT NULL;

CREATE OR REPLACE VIEW public.v_pinnacle_top_sales WITH (security_invoker = on) AS
 SELECT md5(ps.id)::uuid AS sale_id,
    NULL::uuid AS edition_id,
    ps.render_id AS external_id,
    'disney_pinnacle'::text AS collection,
    '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid AS collection_id,
    btrim(pc.character_name) AS player_name,
    btrim(pc.set_name) AS set_name,
    btrim(pc.franchises[1]) AS team_name,
    btrim(pc.variant) AS tier,
    pc.total_minted AS circulation_count,
    pc.thumbnail_url,
    NULL::uuid AS moment_id,
    ps.nft_id,
    ps.serial_number,
    ps.sale_price_usd AS price_usd,
    ps.sold_at,
    ps.buyer_address,
    ps.seller_address,
    'disney_pinnacle'::text AS marketplace,
    NULL::text AS subedition_name
   FROM pinnacle_sales ps
     JOIN pinnacle_catalog pc ON pc.render_id = ps.render_id
  WHERE ps.sale_price_usd >= 100::numeric AND ps.sold_at >= (now() - '30 days'::interval) AND ps.source IS DISTINCT FROM 'pinnacle_studio_history_v1'::text AND pc.thumbnail_url IS NOT NULL;

DO $post$
DECLARE
  v record;
BEGIN
  FOR v IN SELECT * FROM (VALUES
      ('allday_squeeze_board', 23), ('allday_serial_premiums_board', 16), ('allday_perfect_mint_premiums_board', 17),
      ('v_panini_top_sales', 20), ('v_pinnacle_top_sales', 20)) t(name, ncols)
  LOOP
    IF (SELECT count(*) FROM pg_attribute WHERE attrelid = ('public.' || v.name)::regclass AND attnum > 0 AND NOT attisdropped) <> v.ncols
       OR (SELECT attname FROM pg_attribute WHERE attrelid = ('public.' || v.name)::regclass AND attnum = v.ncols) <> 'subedition_name'
       OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = ('public.' || v.name)::regclass AND reloptions @> ARRAY['security_invoker=on']) THEN
      RAISE EXCEPTION 'post-flight failed for %', v.name;
    END IF;
  END LOOP;
END
$post$;
