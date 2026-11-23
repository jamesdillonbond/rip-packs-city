-- audit_20261123_v_panini_top_sales_uncatalogued
--
-- The THIRD state of v_panini_top_sales (read ok + unrenderable). That view inner-joins the
-- bridged `editions` row and needs its thumbnail, so a Panini sale whose card was never
-- catalogued (a 1/1 nobody listed is never seen by the listing walk) is dropped with no trace.
-- 2026-11-23: it dropped the week's two biggest sales ($10,000 Haaland, $7,500 Rodman) from
-- /insights/top-sales and the Monday X draft, and the 11-09 draft's #1 ($2,600 on 11-08 was
-- above its $2,500 #1). 30-day population that morning: 17 sales >= $100, $36,099.
--
-- This view lists exactly the rows v_panini_top_sales drops (same price/window bounds), so
-- lib/insights/top-sales.ts can report them in the API's meta and the X draft can warn
-- instead of publishing a top 10 that is missing its top. It never fabricates a name.
--
-- REVERT: drop view public.v_panini_top_sales_uncatalogued;

create view public.v_panini_top_sales_uncatalogued with (security_invoker = on) as
 SELECT ps.sku,
    ps.edition_external_id,
    (substring(ps.sku from '__([0-9]+)_[0-9]+$'))::integer AS serial_number,
    ps.amount_usd AS price_usd,
    ps.sold_at
   FROM panini_sales ps
     LEFT JOIN editions e ON ((e.external_id = ps.edition_external_id) AND (e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid))
  WHERE ((ps.amount_usd >= (100)::numeric) AND (ps.sold_at >= (now() - '30 days'::interval))
         AND (e.id IS NULL OR e.thumbnail_url IS NULL));
revoke all on public.v_panini_top_sales_uncatalogued from public, anon, authenticated;
grant select on public.v_panini_top_sales_uncatalogued to service_role;
comment on view public.v_panini_top_sales_uncatalogued is
  'Panini sales v_panini_top_sales drops (no bridged edition or no thumbnail), same bounds (>= $100, 30 d). Service-role only. Read by lib/insights/top-sales.ts into meta.uncatalogued. 2026-11-23.';
