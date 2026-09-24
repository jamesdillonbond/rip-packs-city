-- 2026-09-23 · get_pack_metrics(): its OUT columns (floor_ask_usd, packs_remaining,
-- buyable, retired, …) share names with table columns it reads, so the first call
-- raised 42702 "column reference is ambiguous". `#variable_conflict use_column`
-- resolves every such reference to the TABLE column; the OUT parameters are only
-- ever filled by RETURN QUERY. Body otherwise identical to 20260924…_pack_metrics_all_collections_with_history.
-- REVERT: none needed (the previous body could not execute).

CREATE OR REPLACE FUNCTION public.get_pack_metrics()
RETURNS TABLE (
  collection_slug text,
  ev_dists integer, ev_with_value integer,
  buyable integer, retired integer, availability_unknown integer,
  sales_24h integer, sales_7d integer, newest_sale_at timestamptz, sale_ingest_lag_min numeric,
  opens_24h integer, opens_7d integer, newest_open_at timestamptz,
  opens_named_pct_30d numeric, open_value_pct_30d numeric, purchases_named_pct_30d numeric,
  floor_ask_usd numeric, packs_remaining bigint,
  notes text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
#variable_conflict use_column
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_ad constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
BEGIN
  RETURN QUERY
  WITH avail AS (
    SELECT t.collection_slug AS slug,
           count(*)::int AS ev_dists,
           count(*) FILTER (WHERE t.pack_ev IS NOT NULL OR t.gross_ev IS NOT NULL)::int AS ev_with_value,
           count(*) FILTER (WHERE t.primary_available IS TRUE OR t.secondary_available IS TRUE)::int AS buyable,
           count(*) FILTER (WHERE t.primary_available IS FALSE AND t.secondary_available IS FALSE)::int AS retired
      FROM public.pack_table_rows t
     GROUP BY 1
  ), sales AS (
    SELECT 'nba-top-shot'::text AS slug,
           count(*) FILTER (WHERE h.block_time > now() - interval '24 hours')::int AS s24,
           count(*) FILTER (WHERE h.block_time > now() - interval '7 days')::int AS s7,
           max(h.block_time) AS newest,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM h.ingested_at - h.block_time)/60)
                   FILTER (WHERE h.ingested_at > now() - interval '24 hours' AND h.block_time > now() - interval '48 hours'))::numeric, 1) AS lag
      FROM public.topshot_pack_sales_history h WHERE h.block_time > now() - interval '8 days'
    UNION ALL
    SELECT 'nfl-all-day', count(*) FILTER (WHERE h.block_time > now() - interval '24 hours')::int,
           count(*) FILTER (WHERE h.block_time > now() - interval '7 days')::int, max(h.block_time),
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM h.ingested_at - h.block_time)/60)
                   FILTER (WHERE h.ingested_at > now() - interval '24 hours' AND h.block_time > now() - interval '48 hours'))::numeric, 1)
      FROM public.allday_pack_sales_history h WHERE h.block_time > now() - interval '8 days'
    UNION ALL
    SELECT 'laliga-golazos', count(*) FILTER (WHERE h.block_time > now() - interval '24 hours')::int,
           count(*) FILTER (WHERE h.block_time > now() - interval '7 days')::int,
           (SELECT max(block_time) FROM public.golazos_pack_sales_history), NULL::numeric
      FROM public.golazos_pack_sales_history h WHERE h.block_time > now() - interval '8 days'
    UNION ALL
    SELECT 'candy-mlb', count(*) FILTER (WHERE s.sold_at > now() - interval '24 hours')::int,
           count(*) FILTER (WHERE s.sold_at > now() - interval '7 days')::int,
           (SELECT max(sold_at) FROM public.candy_pack_sales), NULL::numeric
      FROM public.candy_pack_sales s WHERE s.sold_at > now() - interval '8 days'
  ), opens AS (
    SELECT CASE r.collection_id WHEN v_ts THEN 'nba-top-shot' ELSE 'nfl-all-day' END AS slug,
           count(*) FILTER (WHERE r.sealed_at > now() - interval '24 hours')::int AS o24,
           count(*) FILTER (WHERE r.sealed_at > now() - interval '7 days')::int AS o7,
           max(r.sealed_at) AS newest,
           round(100.0 * count(*) FILTER (WHERE r.dist_id IS NOT NULL) / NULLIF(count(*), 0), 1) AS named,
           round(100.0 * count(*) FILTER (WHERE r.pull_value_usd > 0) / NULLIF(count(*), 0), 1) AS valued
      FROM public.pack_rips r
     WHERE r.collection_id IN (v_ts, v_ad) AND r.sealed_at > now() - interval '30 days'
     GROUP BY 1
    UNION ALL
    SELECT 'laliga-golazos',
           count(*) FILTER (WHERE o.opened_at > now() - interval '24 hours')::int,
           count(*) FILTER (WHERE o.opened_at > now() - interval '7 days')::int,
           (SELECT max(opened_at) FROM public.golazos_pack_opens),
           round(100.0 * count(*) FILTER (WHERE o.dist_id IS NOT NULL) / NULLIF(count(*), 0), 1),
           round(100.0 * count(*) FILTER (WHERE o.pull_value_usd > 0) / NULLIF(count(*), 0), 1)
      FROM public.golazos_pack_opens o WHERE o.opened_at > now() - interval '30 days'
    UNION ALL
    SELECT 'disney-pinnacle',
           count(*) FILTER (WHERE b.minted_at > now() - interval '24 hours' AND b.pins_minted > 1)::int,
           count(*) FILTER (WHERE b.minted_at > now() - interval '7 days' AND b.pins_minted > 1)::int,
           max(b.minted_at) FILTER (WHERE b.pins_minted > 1), NULL::numeric, NULL::numeric
      FROM public.v_pinnacle_mint_batches b WHERE b.minted_at > now() - interval '8 days'
  ), purch AS (
    SELECT CASE p.collection_id WHEN v_ts THEN 'nba-top-shot' ELSE 'nfl-all-day' END AS slug,
           round(100.0 * count(*) FILTER (WHERE p.pack_dist_id IS NOT NULL) / NULLIF(count(*), 0), 1) AS named
      FROM public.pack_purchases p
     WHERE p.collection_id IN (v_ts, v_ad) AND p.sealed_at > now() - interval '30 days'
     GROUP BY 1
  ), slugs(slug) AS (
    VALUES ('nba-top-shot'), ('nfl-all-day'), ('laliga-golazos'), ('disney-pinnacle'), ('ufc-strike'), ('candy-mlb'), ('panini-blockchain')
  )
  SELECT s.slug,
         CASE s.slug WHEN 'candy-mlb' THEN 1 WHEN 'panini-blockchain' THEN (SELECT count(*)::int FROM public.panini_pack_ev_board) ELSE a.ev_dists END,
         CASE s.slug WHEN 'candy-mlb' THEN (SELECT count(*)::int FROM public.candy_pack_ev_model m WHERE m.actual_ev_usd IS NOT NULL)
                     WHEN 'panini-blockchain' THEN (SELECT count(*)::int FROM public.panini_pack_ev_board b WHERE b.actual_ev_usd IS NOT NULL)
                     ELSE a.ev_with_value END,
         CASE s.slug WHEN 'candy-mlb' THEN (SELECT CASE WHEN active_asks > 0 THEN 1 ELSE 0 END FROM public.candy_pack_market)
                     WHEN 'panini-blockchain' THEN (SELECT count(*)::int FROM public.panini_pack_state p WHERE p.floor_usd > 0)
                     ELSE a.buyable END,
         a.retired,
         CASE WHEN a.slug IS NULL THEN NULL ELSE a.ev_dists - a.buyable - a.retired END,
         sa.s24, sa.s7, sa.newest, sa.lag,
         CASE s.slug WHEN 'candy-mlb' THEN NULL ELSE o.o24 END,
         CASE s.slug WHEN 'candy-mlb' THEN NULL ELSE o.o7 END,
         o.newest, o.named, o.valued, pu.named,
         CASE s.slug WHEN 'candy-mlb' THEN (SELECT floor_ask_usd FROM public.candy_pack_market)
                     WHEN 'panini-blockchain' THEN (SELECT min(floor_usd) FROM public.panini_pack_state)
                     ELSE NULL END,
         CASE s.slug WHEN 'candy-mlb' THEN (SELECT treasury_held::bigint FROM public.candy_pack_market)
                     WHEN 'panini-blockchain' THEN (SELECT sum(packs_remaining)::bigint FROM public.panini_pack_state)
                     ELSE NULL END,
         CASE s.slug
           WHEN 'disney-pinnacle' THEN 'Packs are sold off-chain: no pack sales feed exists; opens are INFERRED from multi-pin mint transactions.'
           WHEN 'ufc-strike' THEN 'No pack source: UFC Strike packs are not indexed by Dapper''s studio API and RPC has no pack table for them.'
           WHEN 'candy-mlb' THEN 'Solana. Sales from Magic Eden (candy_pack_sales); opens = burnt pack assets (0 burnt: packs are not yet openable on chain); packs_remaining = treasury-held.'
           WHEN 'panini-blockchain' THEN 'Ethereum. Panini publishes pack STATS, not a transaction feed: sales = floor/avg/recent sale snapshots (panini_pack_state_history), opens = packs_total - packs_remaining.'
           WHEN 'laliga-golazos' THEN 'Pack sales + opens lanes added 2026-09-23 (Dapper studio index).'
           ELSE NULL END
    FROM slugs s
    LEFT JOIN avail a ON a.slug = s.slug
    LEFT JOIN sales sa ON sa.slug = s.slug
    LEFT JOIN opens o ON o.slug = s.slug
    LEFT JOIN purch pu ON pu.slug = s.slug;
END
$fn$;
REVOKE ALL ON FUNCTION public.get_pack_metrics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pack_metrics() TO service_role, postgres;
