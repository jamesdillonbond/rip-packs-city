-- audit_20261026_pinnacle_top_sales_and_render_pack_pulls
--
-- Disney Pinnacle ↔ Top Shot parity pass (Cowork, 2026-10-26 evening PT; Trevor: "continue the
-- pinnacle roadmap, and try to identify opportunities to reach feature parity with top shot").
--
-- (1) v_pinnacle_top_sales — Pinnacle on the cross-collection Top Sales board and the concierge's
--     get_top_sales. Pinnacle sales live in pinnacle_sales, never in `sales`, so v_insights_top_sales
--     (sales ⋈ editions) cannot carry them: `?collection=disney_pinnacle` was an accepted filter that
--     always answered with zero rows, and the concierge then said RPC had indexed N Pinnacle sales
--     "none of them on this board" — read by a collector as "nothing sold for $100+". Measured
--     2026-10-26 ~6:40 PM PT: 147 on-chain Pinnacle sales >= $100 in 30 days (max $10,990), 0 from the
--     studio-history source in that window (so no studio twins can reach it, #159/#200).
--     Same columns, bounds and order as v_insights_top_sales (>= $100, 30 days). Shaped like
--     v_panini_top_sales: a separate service-role view merged server-side by lib/insights/top-sales.ts
--     (pinnacle_sales is not anon-readable, so a union into the anon-granted view would fail every anon
--     read). The pin is the render: external_id = render_id (the board links /pinnacle/moment/<render>),
--     player_name = the pin's character name, team_name = its first franchise, tier = its variant,
--     circulation = total_minted. thumbnail_url is the catalog's own same-origin image proxy path.
--     sale_id is md5(pinnacle_sales.id)::uuid (the sibling column is uuid).
--
-- (2) mv_pinnacle_render_pack_pulls — "Found in these packs" for a pin page (Top Shot's edition page
--     has it; the Pinnacle pin page did not). One row per (render_id, dist_id): how many pulls of that
--     pin RPC has seen come out of that pack distribution. A pulled nft_id is named by its mint event
--     (pinnacle_mint_events, every mint since the spork floor) or by the chain read at the open block
--     (pinnacle_pull_chain_reads.edition_id → pinnacle_catalog.edition_id, 1:1, 0 duplicate edition_ids).
--     Measured 2026-10-26: 96,474 pulls across 107 dists, 78,531 named (81 %); the two sources never
--     overlap (0 nft_ids in both), and against an independent source (wallet_moments_cache.render_id
--     for the same nft_id) they agree 995/995 (mint) and 54/54 (chain). The 19 % unnamed pulls are NOT
--     in the view, so a count here is a LOWER BOUND — the page says so.
--     Refreshed every 3 h by pg_cron through refresh_pinnacle_render_pack_pulls(), which logs
--     pipeline `pinnacle-render-pack-pulls` and fails (ok=false) on zero rows.
--
-- anon-exec: revoked (refresh_pinnacle_render_pack_pulls) — new maintenance fn; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- REVERT:
--   select cron.unschedule('rpc-pinnacle-render-pack-pulls');
--   drop function public.refresh_pinnacle_render_pack_pulls();
--   drop materialized view public.mv_pinnacle_render_pack_pulls;
--   drop view public.v_pinnacle_top_sales;

create view public.v_pinnacle_top_sales with (security_invoker = on) as
 SELECT (md5(ps.id))::uuid AS sale_id,
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
    'disney_pinnacle'::text AS marketplace
   FROM pinnacle_sales ps
     JOIN pinnacle_catalog pc ON pc.render_id = ps.render_id
  WHERE ps.sale_price_usd >= (100)::numeric
    AND ps.sold_at >= (now() - '30 days'::interval)
    AND ps.source IS DISTINCT FROM 'pinnacle_studio_history_v1'
    AND pc.thumbnail_url IS NOT NULL;
revoke all on public.v_pinnacle_top_sales from public, anon, authenticated;
grant select on public.v_pinnacle_top_sales to service_role;
comment on view public.v_pinnacle_top_sales is
  'Disney Pinnacle sales for the Top Sales board, shaped like v_insights_top_sales (>= $100, 30 d). external_id = render_id. Service-role only (pinnacle_sales is not anon-readable); merged server-side by lib/insights/top-sales.ts. Studio-history rows excluded (twins, #159/#200). 2026-10-26.';

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_pinnacle_render_pack_pulls AS
WITH pulls AS (
  SELECT o.dist_id, o.opened_at, x.nft_id
    FROM public.pinnacle_pack_opens o
   CROSS JOIN LATERAL unnest(o.nft_ids) AS x(nft_id)
), named AS (
  SELECT p.dist_id, p.opened_at, COALESCE(m.render_id, c.render_id) AS render_id
    FROM pulls p
    LEFT JOIN public.pinnacle_mint_events m ON m.nft_id = p.nft_id
    LEFT JOIN public.pinnacle_pull_chain_reads cr ON cr.nft_id = p.nft_id AND m.nft_id IS NULL
    LEFT JOIN public.pinnacle_catalog c ON c.edition_id = cr.edition_id::text
)
SELECT render_id, dist_id, count(*)::int AS pulls, min(opened_at) AS first_opened_at, max(opened_at) AS last_opened_at
  FROM named
 WHERE render_id IS NOT NULL AND dist_id IS NOT NULL
 GROUP BY render_id, dist_id
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_pinnacle_render_pack_pulls_key
  ON public.mv_pinnacle_render_pack_pulls (render_id, dist_id);

REVOKE ALL ON public.mv_pinnacle_render_pack_pulls FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_pinnacle_render_pack_pulls TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_pinnacle_render_pack_pulls IS
  'Disney Pinnacle: pulls of each render (pin) seen per pack distribution — the pin page''s "Found in these packs". Named by mint event or the open-block chain read; ~19 % of pulls are unnamed, so counts are a lower bound. Refreshed every 3 h (refresh_pinnacle_render_pack_pulls, pipeline pinnacle-render-pack-pulls). 2026-10-26.';

CREATE OR REPLACE FUNCTION public.refresh_pinnacle_render_pack_pulls()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  IF (SELECT relispopulated FROM pg_class WHERE oid = 'public.mv_pinnacle_render_pack_pulls'::regclass) THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_pinnacle_render_pack_pulls;
  ELSE
    REFRESH MATERIALIZED VIEW public.mv_pinnacle_render_pack_pulls;
  END IF;
  SELECT count(*) INTO v_rows FROM public.mv_pinnacle_render_pack_pulls;
  PERFORM public.log_pipeline_run('pinnacle-render-pack-pulls', v_started, v_rows, v_rows, 0, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'refresh produced no rows' END,
    'disney_pinnacle', NULL, NULL, jsonb_build_object('source', 'audit_20261026'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('pinnacle-render-pack-pulls', v_started, 0, 0, 0, false, SQLERRM,
    'disney_pinnacle', NULL, NULL, jsonb_build_object('source', 'audit_20261026', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.refresh_pinnacle_render_pack_pulls() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_pinnacle_render_pack_pulls() TO postgres, service_role;

-- Every 3 h at :04 (1:04, 4:04 … UTC; minute 4 carries one other job). Pack opens are ingested every 15 min; a pin page that reads
-- "found in" three hours late understates a brand-new drop by at most one refresh.
SELECT cron.schedule('rpc-pinnacle-render-pack-pulls', '4 1-22/3 * * *',
  $$select public.refresh_pinnacle_render_pack_pulls()$$);
