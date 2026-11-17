-- audit_20261010_v_panini_top_sales
--
-- Panini on the cross-collection Top Sales board (/insights/top-sales). Trevor, 2026-10-10: bring
-- Top Shot's boards to Panini ("Do it all"). Panini sales never reach `sales` (they live in
-- panini_sales, every sale the walk reads), so v_insights_top_sales cannot carry them.
--
-- WHY A SEPARATE VIEW, NOT A UNION INTO v_insights_top_sales: that view is security_invoker AND
-- granted to anon; panini_sales has RLS on with NO policy and no anon grant. A union would make
-- every anon read of the existing view fail on panini_sales. This view is service_role only, and
-- lib/insights/top-sales.ts merges it with the existing one server-side (same filters, same order).
--
-- Same columns, types and bounds as v_insights_top_sales: price >= $100, last 30 days, an edition
-- thumbnail present (the bridged shared `editions` row, Panini collection). sale_id is a
-- deterministic uuid from (sku, sold_at) — the column is uuid in the sibling view. nft_id is NULL:
-- the board's /moment/<nft_id> drill-down is a Flow moment page, so a Panini row links its edition
-- page (external_id) instead. serial_number comes from the sku ("<psku>__<serial>_<cap>").
-- buyer/seller are Panini USERNAMES (public on Panini's marketplace), carried in the *_address
-- columns the sibling view uses; the fetcher shows them as-is and never resolves them as addresses.
-- Measured 2026-10-10 PT: 515 Panini sales >= $100 in 30 days (vs 537 on every other collection).
--
-- REVERT: drop view public.v_panini_top_sales;

create view public.v_panini_top_sales with (security_invoker = on) as
 SELECT (md5(ps.sku || '|' || ps.sold_at::text))::uuid AS sale_id,
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
    (substring(ps.sku from '__([0-9]+)_[0-9]+$'))::integer AS serial_number,
    ps.amount_usd AS price_usd,
    ps.sold_at,
    ps.buyer AS buyer_address,
    ps.seller AS seller_address,
    'panini'::text AS marketplace
   FROM panini_sales ps
     JOIN editions e ON ((e.external_id = ps.edition_external_id) AND (e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid))
  WHERE ((ps.amount_usd >= (100)::numeric) AND (ps.sold_at >= (now() - '30 days'::interval)) AND (e.thumbnail_url IS NOT NULL));
revoke all on public.v_panini_top_sales from public, anon, authenticated;
grant select on public.v_panini_top_sales to service_role;
comment on view public.v_panini_top_sales is
  'Panini sales for the Top Sales board, shaped like v_insights_top_sales (>= $100, 30 d, thumbnail present). Service-role only (panini_sales is not anon-readable); merged server-side by lib/insights/top-sales.ts. buyer/seller = Panini usernames. 2026-10-10.';
