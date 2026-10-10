-- audit_20261010_panini_parallel_and_serial_premiums
--
-- Two Panini boards modelled on Top Shot's /insights/parallel-premiums and /insights/serial-premiums
-- (Trevor, 2026-10-10: bring Top Shot's tools to Panini — "Do it all"). They back the new
-- /insights/panini-premiums page. Service-role only (panini_* tables have no anon grant); the page
-- reads them server-side.
--
-- 1. panini_parallel_premiums — what a numbered BASE parallel's FMV commands over the same player's
--    most common base parallel in the same product (e.g. Messi Base Prizms Cracked Ice /25 vs Base
--    Prizms Silver /259 in 2026 Prizm World Cup). Reference = the player's base-family edition with
--    the highest mint cap (ties: lowest external_id), only parallels scarcer than it. FMV is
--    edition_fmv_current (the bridge's copy of the panini-1.x snapshot), restricted on BOTH sides to
--    HIGH / MEDIUM / LOW: an ASK_ONLY price is one listing (27 % of Panini FMV dollars rests on them,
--    known-issues 5b) and would manufacture premiums. Both confidences are returned so the page can
--    offer a HIGH/MEDIUM-only view. Measured 2026-10-10 PT: 7,389 pairs, 7.4k buffers, 0.13 s.
-- 2. panini_serial_premiums — REAL sales (last 90 days) of an edition's #1 or its perfect mint
--    (#N/N), against the median of that edition's other sales in the same window (>= 3 of them),
--    kept at >= 2x. Both flags come from the sku ("<psku>__<serial>_<cap>"), never a join: the
--    jersey-mint flag needs a per-sale panini_card_serials probe that cost 400k buffers / 31 s here,
--    so it is left out (as Top Shot's board offers #1 and perfect only). Measured: 389 rows,
--    13.5k buffers, 2.7 s cold. Coverage caveat the page states: panini_sales holds the sales RPC's
--    walk has read, not a census.
--
-- REVERT: drop view public.panini_serial_premiums; drop view public.panini_parallel_premiums;

create view public.panini_parallel_premiums with (security_invoker = on) as
 WITH f AS (
         SELECT pe.external_id,
            pe.product_set_id,
            pe.player_name,
            pe.set_name,
            pe.mint_cap,
            pe.thumbnail_url,
            efc.fmv_usd,
            efc.confidence
           FROM ((panini_editions pe
             JOIN editions e ON (((e.external_id)::text = pe.external_id) AND (e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid)))
             JOIN edition_fmv_current efc ON ((efc.edition_id = e.id)))
          WHERE ((pe.parallel_family = 'base'::text) AND (pe.player_name IS NOT NULL) AND (pe.mint_cap IS NOT NULL) AND (efc.fmv_usd > (0)::numeric) AND (efc.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence])))
        ), ref AS (
         SELECT DISTINCT ON (f.product_set_id, f.player_name) f.external_id,
            f.product_set_id,
            f.player_name,
            f.set_name,
            f.mint_cap,
            f.fmv_usd,
            f.confidence
           FROM f
          ORDER BY f.product_set_id, f.player_name, f.mint_cap DESC, f.external_id
        )
 SELECT f.product_set_id,
    p.name AS product_name,
    p.last_grid_sport AS sport,
    f.player_name,
    f.external_id,
    f.set_name AS parallel,
    f.mint_cap,
    f.thumbnail_url,
    f.fmv_usd AS parallel_fmv_usd,
    f.confidence AS parallel_confidence,
    r.external_id AS base_external_id,
    r.set_name AS base_parallel,
    r.mint_cap AS base_mint_cap,
    r.fmv_usd AS base_fmv_usd,
    r.confidence AS base_confidence,
    round((f.fmv_usd / r.fmv_usd), 2) AS premium_mult
   FROM ((f
     JOIN ref r ON (((r.product_set_id = f.product_set_id) AND (r.player_name = f.player_name) AND (r.external_id <> f.external_id))))
     LEFT JOIN panini_products p ON ((p.set_id = f.product_set_id)))
  WHERE (f.mint_cap < r.mint_cap);
revoke all on public.panini_parallel_premiums from public, anon, authenticated;
grant select on public.panini_parallel_premiums to service_role;
comment on view public.panini_parallel_premiums is
  'Panini parallel premiums: a numbered base parallel''s FMV over the same player''s most common base parallel in the same product. FMV from edition_fmv_current, HIGH/MEDIUM/LOW only on both sides (no ASK_ONLY). Backs /insights/panini-premiums. 2026-10-10.';

create view public.panini_serial_premiums with (security_invoker = on) as
 WITH s AS (
         SELECT ps.sku,
            ps.edition_external_id,
            ps.amount_usd,
            ps.sold_at,
            (substring(ps.sku FROM '__([0-9]+)_[0-9]+$'::text))::integer AS serial_number,
            (substring(ps.sku FROM '__[0-9]+_([0-9]+)$'::text))::integer AS mint_cap
           FROM panini_sales ps
          WHERE ((ps.sold_at >= (now() - '90 days'::interval)) AND (ps.amount_usd > (0)::numeric))
        ), typ AS (
         SELECT s.edition_external_id,
            (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((s.amount_usd)::double precision)))::numeric AS median_usd,
            (count(*))::integer AS sales_n
           FROM s
          WHERE ((s.serial_number <> 1) AND (s.serial_number <> s.mint_cap))
          GROUP BY s.edition_external_id
         HAVING (count(*) >= 3)
        )
 SELECT pe.product_set_id,
    p.name AS product_name,
    p.last_grid_sport AS sport,
    pe.player_name,
    pe.set_name AS parallel,
    pe.thumbnail_url,
    s.edition_external_id AS external_id,
    s.sku,
    s.serial_number,
    s.mint_cap,
        CASE
            WHEN (s.serial_number = 1) THEN 'number 1'::text
            ELSE 'perfect mint'::text
        END AS headline,
    s.amount_usd AS sale_usd,
    s.sold_at,
    round(t.median_usd, 2) AS edition_median_usd,
    t.sales_n AS edition_sales_n,
    round((s.amount_usd / NULLIF(t.median_usd, (0)::numeric)), 1) AS premium_mult
   FROM (((s
     JOIN typ t ON ((t.edition_external_id = s.edition_external_id)))
     JOIN panini_editions pe ON ((pe.external_id = s.edition_external_id)))
     LEFT JOIN panini_products p ON ((p.set_id = pe.product_set_id)))
  WHERE (((s.serial_number = 1) OR ((s.serial_number = s.mint_cap) AND (s.mint_cap > 1))) AND (t.median_usd > (0)::numeric) AND (s.amount_usd >= ((2)::numeric * t.median_usd)));
revoke all on public.panini_serial_premiums from public, anon, authenticated;
grant select on public.panini_serial_premiums to service_role;
comment on view public.panini_serial_premiums is
  'Panini serial premiums: real sales (90 d) of an edition''s #1 or perfect mint at >= 2x the median of its other sales (>= 3) in the window. Flags from the sku. Coverage = sales RPC''s walk has read. Backs /insights/panini-premiums. 2026-10-10.';
