-- audit_20261019_panini_flip_readiness_blockers
--
-- Trevor 2026-10-19 11:12 AM PT: "Do all of it" — clear the remaining blockers found by the
-- 10-19 reader audit of collections.is_active (known-issues #64), then flip Panini active.
-- EVERY change here is a no-op while panini_blockchain.is_active = false (verified before
-- and after apply); each removes what the flip would otherwise do wrong:
--
-- (1) editions_unified: drop the `panini_editions` UNION arm. After the flip its `editions`
--     arm (is_active-gated) already returns Panini's 36,504 bridged rows — the panini_editions
--     arm would have listed every one a second time (73,008). Its only dependent is
--     sets_summary, whose own Panini arm reads `editions` while NOT is_active with the same
--     columns as the editions arm, so the matview's Panini sets are identical before and after.
--     security_invoker kept (WITH clause; CREATE OR REPLACE VIEW would otherwise reset it).
-- (2) analytics_liquidity_distribution: exclude Panini — liquidity_rating is NULL on 100 % of
--     Panini snapshots, so every Panini edition would read "cold".
-- (3) analytics_fmv_tier_pulse: exclude Panini (as Pinnacle is) — the public /analytics/fmv
--     board has no Panini key, so the flip would add an unlabelled row there.
-- (4) get_platform_stats: Panini out of `per_collection` (its sales/listings would read 0 from
--     `sales` / `cached_listings`); `collection_count` keeps counting active collections (7 is
--     true after the flip — Panini is published).
-- (5) health_check: Panini out of `collection_coverage` (sales 0, acquisitions 0 from `sales`).
-- (6) rpc_wmc_fmv_populate_backstop: Panini out of its loop (0 wmc rows; a permanent-zero lane).
-- NOT changed: the deal-alert builders (two are pinned) — their sources hold no Panini rows, so
-- they produce nothing for Panini; recorded in #64 as a review point if a Panini ask source is
-- ever added to the deals MV.
--
-- (2)–(6) are md5-gated one-anchor rewrites (the 20261009202625 pattern; all unpinned).
-- anon-exec: unchanged (analytics_liquidity_distribution) — rewritten via pg_get_functiondef; ACL preserved, verified has_function_privilege anon=false.
-- anon-exec: unchanged (analytics_fmv_tier_pulse) — rewritten via pg_get_functiondef; ACL preserved, verified anon=false.
-- anon-exec: unchanged (get_platform_stats) — rewritten via pg_get_functiondef; ACL preserved, verified anon=false.
-- anon-exec: unchanged (health_check) — rewritten via pg_get_functiondef; ACL preserved, verified anon=false.
-- anon-exec: unchanged (rpc_wmc_fmv_populate_backstop) — rewritten via pg_get_functiondef; ACL preserved, verified anon=false.
--
-- REVERT: re-add the panini_editions arm to editions_unified (body in this file's history /
-- 20260927180751-era definition) and run each anchor replacement in reverse (b→a).

CREATE OR REPLACE VIEW public.editions_unified WITH (security_invoker = on) AS
 SELECT e.id::text AS id,
    'editions'::text AS source_table,
    e.collection_id,
    e.external_id,
    COALESCE(e.external_id, e.id::text::character varying) AS route_slug,
    e.name,
    e.player_name,
    e.set_name,
    e.tier::text AS tier,
    e.series::text AS series_label,
    e.series AS series_num,
    e.edition_kind::text AS edition_kind,
    e.circulation_count,
    e.thumbnail_url,
    e.video_url,
    e.team_name,
    e.first_minted_at,
    e.created_at,
    e.updated_at
   FROM editions e
  WHERE (EXISTS ( SELECT 1
           FROM collections c
          WHERE c.id = e.collection_id AND c.is_active IS TRUE))
UNION ALL
 SELECT pe.id,
    'pinnacle_editions'::text AS source_table,
    '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid AS collection_id,
    pe.external_id,
    pe.id AS route_slug,
    ((((pe.character_name || ' - '::text) || pe.set_name) || ' ('::text) || pe.variant_type) || ')'::text AS name,
    pe.character_name AS player_name,
    pe.set_name,
    pe.variant_type AS tier,
    pe.series_year::text AS series_label,
    pe.series_year::smallint AS series_num,
    pe.edition_type AS edition_kind,
    pe.mint_count AS circulation_count,
    pe.thumbnail_url,
    NULL::text AS video_url,
    pe.franchise AS team_name,
    pe.minting_date AS first_minted_at,
    pe.created_at,
    pe.updated_at
   FROM pinnacle_editions pe
  WHERE (EXISTS ( SELECT 1
           FROM collections c
          WHERE c.id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid AND c.is_active IS TRUE));

DO $$
DECLARE
  r record; v_oid oid; v_src text; v_def text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('analytics_liquidity_distribution', '7f8063cca528762d1eaaf5399f80ac37',
       E'    FROM collections c\n    WHERE c.is_active = true\n  ),',
       E'    FROM collections c\n    WHERE c.is_active = true\n      AND c.slug <> ''panini_blockchain''  -- #64: liquidity_rating is NULL on every Panini snapshot\n  ),'),
    ('get_platform_stats', 'b1887a0cb7159db6c49f54293f441e3d',
       E'    FROM collections c\n    WHERE c.is_active = true\n  ) agg;',
       E'    FROM collections c\n    WHERE c.is_active = true\n      AND c.slug <> ''panini_blockchain''  -- #64: Panini sales/listings are not in sales/cached_listings\n  ) agg;'),
    ('health_check', 'eedc0b989a479f3d3cd680a0c792b318',
       E'    FROM collections c\n    WHERE c.is_active = true\n  ),',
       E'    FROM collections c\n    WHERE c.is_active = true\n      AND c.slug <> ''panini_blockchain''  -- #64: coverage here reads sales/acquisitions\n  ),'),
    ('analytics_fmv_tier_pulse', '58bb20b4472c9d4d87d7f5ffe63071ad',
       E'      AND c.is_active = true\n      AND c.slug <> ''disney_pinnacle''',
       E'      AND c.is_active = true\n      AND c.slug <> ''disney_pinnacle''\n      AND c.slug <> ''panini_blockchain''  -- #64: the /analytics/fmv board has no Panini key'),
    ('rpc_wmc_fmv_populate_backstop', 'e7d87754e6221bdf4eae9a52a6990bf3',
       E'WHERE c.is_active ORDER BY c.slug LOOP',
       E'WHERE c.is_active AND c.slug <> ''panini_blockchain'' ORDER BY c.slug LOOP')
  ) AS t(fn, md5_before, a, b)
  LOOP
    SELECT p.oid, p.prosrc INTO v_oid, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn;
    IF v_oid IS NULL THEN RAISE EXCEPTION '% not found', r.fn; END IF;
    IF md5(v_src) <> r.md5_before THEN RAISE EXCEPTION '% changed since read (md5 %)', r.fn, md5(v_src); END IF;
    IF (length(v_src) - length(replace(v_src, r.a, ''))) / length(r.a) <> 1 THEN
      RAISE EXCEPTION '% anchor does not occur exactly once', r.fn;
    END IF;
    v_def := replace(pg_get_functiondef(v_oid), r.a, r.b);
    EXECUTE v_def;
  END LOOP;
END $$;
