-- audit_20261029_topshot_boards_name_the_parallel — 2026-10-29 10:23 AM PT applied (Claude Code cloud).
--
-- Follow-on to 20261029171852 (first-mint), which found 254 of 519 trophies were unnamed parallels.
-- Same gap on five more public Top Shot boards: each row carries only set_name, and editions.name does
-- not carry the parallel either, so a Rippled /4000 reads as the standard /4000 of the same set.
-- Parallel rows measured 10-29: squeeze 4,782 of 14,502; top sales 126 of 567; serial premiums 75 of
-- 147; perfect-mint 26 of 56; underpriced serials 6 of 7.
--
-- WHAT CHANGES. Each view appends ONE column, subedition_name (editions.subedition_name, NULL for a
-- standard print). Existing columns, order, filters and grants are unchanged. security_invoker=on is
-- restated, since CREATE OR REPLACE VIEW would otherwise reset it. Each view's live text is md5-guarded,
-- and post-flight asserts the column count rose by exactly one and security_invoker survived.
--
-- REVERT: DROP + re-CREATE each view without its last column, from the bodies below minus the
-- subedition_name line, restating security_invoker=on and the existing grants. (CREATE OR REPLACE
-- cannot drop a column; topshot_squeeze_board has dependent views, so drop those first.)

DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.topshot_squeeze_board'::regclass)) <> '39b5468c06f20105e89ed2f37c180415'
     OR md5(pg_get_viewdef('public.v_insights_top_sales'::regclass)) <> 'd34352db2e238d380f7bd3a1c88a269f'
     OR md5(pg_get_viewdef('public.topshot_serial_premiums_board'::regclass)) <> '358c059440a468e7ae518b94bcc05cf6'
     OR md5(pg_get_viewdef('public.topshot_perfect_mint_premiums_board'::regclass)) <> '759d9afb018010989736b6633130c44d'
     OR md5(pg_get_viewdef('public.topshot_underpriced_serials_board'::regclass)) <> '360551b0c2ac301b9244a76fee506835' THEN
    RAISE EXCEPTION 'a Top Shot board view changed since 2026-10-29 ~10:23 AM PT; re-read it';
  END IF;
END
$guard$;

CREATE OR REPLACE VIEW public.topshot_squeeze_board WITH (security_invoker = on) AS
 SELECT e.id AS edition_id,
    e.external_id,
    COALESCE(e.player_name, be.player_name) AS player_name,
    COALESCE(e.set_name, be.set_name) AS set_name,
    COALESCE(e.tier::text, replace(be.tier, 'MOMENT_TIER_'::text, ''::text)) AS tier,
    COALESCE(e.circulation_count, be.circulation_count) AS circulation,
    be.locked,
    be.burned,
    round(100.0 * COALESCE(be.locked, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS lock_pct,
    round(100.0 * COALESCE(be.burned, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS burn_pct,
    round(100.0 * (COALESCE(be.locked, 0) + COALESCE(be.burned, 0))::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS squeeze_pct,
    GREATEST(COALESCE(e.circulation_count, be.circulation_count, 0) - COALESCE(be.locked, 0) - COALESCE(be.burned, 0), 0) AS effectively_buyable,
        CASE
            WHEN efc.fmv_usd IS NULL THEN NULL::numeric
            ELSE be.low_ask
        END AS low_ask,
    efc.fmv_usd::numeric(12,4) AS fmv_usd,
    efc.confidence::text AS confidence,
    e.game_date,
    e.thumbnail_url,
    efc.fmv_usd IS NOT NULL AND efc.fmv_usd > 0::numeric AND be.low_ask IS NOT NULL AND be.low_ask > (10::numeric * efc.fmv_usd) AS low_ask_disconnected,
    e.set_id,
    e.team_name,
    tec.top5_share_pct,
        CASE
            WHEN tec.census_complete THEN tec.holders
            ELSE NULL::integer
        END AS holders,
    e.subedition_name
   FROM badge_editions be
     JOIN editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
     LEFT JOIN edition_fmv_current efc ON efc.edition_id = e.id
     LEFT JOIN topshot_edition_concentration tec ON tec.edition_external_id = e.external_id::text
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND COALESCE(e.circulation_count, be.circulation_count) IS NOT NULL AND COALESCE(e.circulation_count, be.circulation_count) > 0;

CREATE OR REPLACE VIEW public.v_insights_top_sales WITH (security_invoker = on) AS
 SELECT s.id AS sale_id,
    s.edition_id,
    e.external_id,
    c.slug AS collection,
    e.collection_id,
    e.player_name,
    e.set_name,
    e.team_name,
    e.tier,
    e.circulation_count,
    e.thumbnail_url,
    s.moment_id,
    s.nft_id,
    s.serial_number,
    s.price_usd,
    s.sold_at,
    s.buyer_address,
    s.seller_address,
    s.marketplace,
    e.subedition_name
   FROM sales s
     JOIN editions e ON e.id = s.edition_id
     JOIN collections c ON c.id = e.collection_id
  WHERE s.price_usd >= 100::numeric AND s.sold_at >= (now() - '30 days'::interval) AND e.thumbnail_url IS NOT NULL;

CREATE OR REPLACE VIEW public.topshot_serial_premiums_board WITH (security_invoker = on) AS
 WITH ed_med AS (
         SELECT mv_topshot_edition_median_180d.edition_id,
            mv_topshot_edition_median_180d.edition_median,
            mv_topshot_edition_median_180d.edition_sales_180d
           FROM mv_topshot_edition_median_180d
        ), no1 AS (
         SELECT DISTINCT ON (s.edition_id) s.edition_id,
            s.price_usd AS no1_price,
            s.sold_at AS no1_sold_at,
            s.moment_id,
            s.nft_id
           FROM sales s
          WHERE s.collection = 'nba_top_shot'::text AND s.serial_number = 1 AND s.sold_at >= (now() - '90 days'::interval) AND s.price_usd > 0.50
          ORDER BY s.edition_id, s.sold_at DESC
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
    (EXISTS ( SELECT 1
           FROM topshot_conflated_editions c
          WHERE c.edition_id = e.id)) AS is_conflated,
    e.subedition_name
   FROM no1 n
     JOIN ed_med m ON m.edition_id = n.edition_id
     JOIN editions e ON e.id = n.edition_id
  WHERE e.external_id::text ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'::text AND e.thumbnail_url IS NOT NULL AND m.edition_median >= 0.75::double precision AND (n.no1_price::double precision / m.edition_median) >= 5::double precision
  ORDER BY (n.no1_price::double precision / m.edition_median) DESC;

CREATE OR REPLACE VIEW public.topshot_perfect_mint_premiums_board WITH (security_invoker = on) AS
 SELECT pm.edition_id,
    pm.external_id,
    pm.player_name,
    pm.set_name,
    pm.tier,
    pm.circulation_count,
    pm.thumbnail_url,
    pm.moment_id,
    pm.nft_id,
    pm.perfect_serial,
    pm.edition_median_usd,
    pm.perfect_last_sale_usd,
    pm.premium_multiple,
    pm.perfect_sold_at,
    pm.edition_sales_180d,
    pm.is_conflated,
    (SELECT e.subedition_name FROM editions e WHERE e.id = pm.edition_id) AS subedition_name
   FROM mv_topshot_perfect_mint_premiums_board pm
  ORDER BY pm.premium_multiple DESC;

CREATE OR REPLACE VIEW public.topshot_underpriced_serials_board WITH (security_invoker = on) AS
 SELECT l.edition_id,
    l.edition_key,
    e.external_id,
    e.player_name,
    e.set_name,
    e.tier::text AS tier,
    e.circulation_count,
    e.thumbnail_url,
    l.nft_id,
    l.serial_number,
    l.ask_usd,
    l.listing_resource_id,
    l.listing_url,
    l.listed_at,
    l.last_seen_at,
    lf.fmv_usd AS edition_fmv_usd,
    lf.confidence,
    sfe.j ->> 'serial_bucket'::text AS serial_bucket,
    (sfe.j ->> 'estimate_usd'::text)::numeric AS serial_fmv_usd,
    (sfe.j ->> 'multiplier'::text)::numeric AS serial_multiplier,
    round(((sfe.j ->> 'estimate_usd'::text)::numeric) - l.ask_usd, 2) AS discount_usd,
    round((((sfe.j ->> 'estimate_usd'::text)::numeric) - l.ask_usd) / NULLIF((sfe.j ->> 'estimate_usd'::text)::numeric, 0::numeric) * 100::numeric, 1) AS discount_pct,
        CASE
            WHEN (l.serial_number = e.circulation_count OR e.tier::text <> 'COMMON'::text) AND ((sfe.j ->> 'multiplier'::text)::numeric) <=
            CASE
                WHEN COALESCE(lf.fmv_usd, 0::numeric) < 10::numeric THEN 7
                WHEN lf.fmv_usd < 90::numeric THEN 4
                ELSE 2
            END::numeric THEN 'tight'::text
            ELSE 'coarse'::text
        END AS estimate_quality,
    e.subedition_name
   FROM topshot_active_listings l
     JOIN editions e ON e.id = l.edition_id
     LEFT JOIN LATERAL ( SELECT fs.fmv_usd,
            fs.confidence::text AS confidence
           FROM fmv_snapshots fs
          WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND fs.edition_id = l.edition_id
          ORDER BY fs.computed_at DESC
         LIMIT 1) lf ON true
     CROSS JOIN LATERAL serial_fmv_estimate('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, l.serial_number, e.circulation_count, e.tier::text, lf.fmv_usd, lf.confidence) sfe(j)
  WHERE l.active AND (l.serial_number = 1 OR l.serial_number = e.circulation_count) AND sfe.j IS NOT NULL AND (sfe.j ->> 'estimate_usd'::text) IS NOT NULL AND l.ask_usd < ((sfe.j ->> 'estimate_usd'::text)::numeric) AND NOT (EXISTS ( SELECT 1
           FROM topshot_conflated_editions c
          WHERE c.edition_id = l.edition_id))
  ORDER BY (round((((sfe.j ->> 'estimate_usd'::text)::numeric) - l.ask_usd) / NULLIF((sfe.j ->> 'estimate_usd'::text)::numeric, 0::numeric) * 100::numeric, 1)) DESC NULLS LAST;

-- Post-flight: each view gained exactly one column, its last is subedition_name, and security_invoker survived.
DO $post$
DECLARE
  v record;
BEGIN
  FOR v IN SELECT * FROM (VALUES
      ('topshot_squeeze_board', 23), ('v_insights_top_sales', 20), ('topshot_serial_premiums_board', 16),
      ('topshot_perfect_mint_premiums_board', 17), ('topshot_underpriced_serials_board', 24)) t(name, ncols)
  LOOP
    IF (SELECT count(*) FROM pg_attribute WHERE attrelid = ('public.' || v.name)::regclass AND attnum > 0 AND NOT attisdropped) <> v.ncols
       OR (SELECT attname FROM pg_attribute WHERE attrelid = ('public.' || v.name)::regclass AND attnum = v.ncols) <> 'subedition_name'
       OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = ('public.' || v.name)::regclass AND reloptions @> ARRAY['security_invoker=on']) THEN
      RAISE EXCEPTION 'post-flight failed for %', v.name;
    END IF;
  END LOOP;
END
$post$;
