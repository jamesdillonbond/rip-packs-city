-- 2026-09-23 · Disney Pinnacle pack OPENS from Dapper's PackNFT index, and a
-- CORRECTION to this session's own earlier migration.
--
-- CORRECTION: 20260924045256 created v_pinnacle_mint_batches as an "inferred pack
-- open" (a multi-pin mint to one wallet). Checked against the data 40 minutes
-- later, that premise is wrong: the pins in opened Pinnacle packs are minted TO
-- THE PINNACLE CONTRACT ACCOUNT (0xedf9df96c92f4595) when the pack is FILLED,
-- weeks before anyone opens it (4 of 4 sampled pulls: minted 08-12 to the
-- contract, pack opened 08-21). Mints to collector wallets (15,083 in 30 d, ~1.5
-- per tx) are a different flow. The view is DROPPED; nothing read it except
-- get_pack_metrics(), which is re-pointed below.
--
-- NEW: Dapper's index holds 904,722 Pinnacle PackNFTs (451,785 Sealed, 88,346
-- Opened, 364,591 "Revealed" placeholders pointing at A.0000000012345abc.
-- PinnacleEmpty — not opens). edge fn ingest-pinnacle-pack-opens walks the
-- Opened ones newest-first into pinnacle_pack_opens. The opener is NULL: every
-- opened PackNFT is owned by the custodial contract. price_pinnacle_pack_opens()
-- prices pulls from pinnacle_mint_events.render_id → pinnacle_catalog.fmv_usd,
-- whole-pack all-or-nothing, NULL -> positive only.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-pinnacle-pack-opens-ingest'); SELECT cron.unschedule('rpc-price-pinnacle-pack-opens');
--   DELETE FROM public.edge_lane_watch WHERE fn_name = 'ingest-pinnacle-pack-opens';
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('pinnacle-pack-opens-ingest','price-pinnacle-pack-opens');
--   DELETE FROM vault.secrets WHERE name = 'cron_gate_key__ingest-pinnacle-pack-opens';
--   DROP FUNCTION public.run_price_pinnacle_pack_opens(); DROP FUNCTION public.price_pinnacle_pack_opens(integer);
--   DROP TABLE public.pinnacle_pack_opens, public.pinnacle_pack_opens_cursor;
--   (get_pack_metrics: re-apply 20260924…_get_pack_metrics_resolves_column_name_conflicts;
--    the dropped view: re-run its CREATE from 20260924045256.)
--
-- anon-exec: NOT intentional for price_pinnacle_pack_opens / run_price_pinnacle_pack_opens — ops writers, ACL set below.

CREATE TABLE IF NOT EXISTS public.pinnacle_pack_opens (
  pack_nft_id     text PRIMARY KEY,
  dist_id         text,
  opener_address  text,
  opened_at       timestamptz,
  open_tx         text,
  open_block      bigint,
  nft_ids         text[] NOT NULL DEFAULT '{}',
  moments_pulled  integer NOT NULL DEFAULT 0,
  pull_value_usd  numeric(14,2),
  priced_at       timestamptz,
  ingested_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pinnacle_pack_opens_dist ON public.pinnacle_pack_opens (dist_id);
CREATE INDEX IF NOT EXISTS idx_pinnacle_pack_opens_opened ON public.pinnacle_pack_opens (opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_pinnacle_pack_opens_unpriced ON public.pinnacle_pack_opens (opened_at DESC) WHERE pull_value_usd IS NULL;

CREATE TABLE IF NOT EXISTS public.pinnacle_pack_opens_cursor (
  id           smallint PRIMARY KEY DEFAULT 1,
  after_cursor text,
  done         boolean DEFAULT false,
  total_seen   bigint,
  updated_at   timestamptz DEFAULT now()
);
ALTER TABLE public.pinnacle_pack_opens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pinnacle_pack_opens_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinnacle_pack_opens, public.pinnacle_pack_opens_cursor FROM anon, authenticated;
GRANT SELECT ON public.pinnacle_pack_opens, public.pinnacle_pack_opens_cursor TO anon, authenticated;
DROP TRIGGER IF EXISTS trg_suppress_redundant_updates ON public.pinnacle_pack_opens;
CREATE TRIGGER trg_suppress_redundant_updates BEFORE UPDATE ON public.pinnacle_pack_opens
  FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();
COMMENT ON TABLE public.pinnacle_pack_opens IS
  'Disney Pinnacle pack opens from Dapper searchPackNft (status Opened). opener_address is NULL by design: opened PackNFTs are owned by the custodial Pinnacle contract. Written by edge fn ingest-pinnacle-pack-opens; pull_value_usd by price_pinnacle_pack_opens. 2026-09-23.';

CREATE OR REPLACE FUNCTION public.price_pinnacle_pack_opens(p_limit integer DEFAULT 3000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_cand int := 0; v_priced int := 0; v_left int := 0;
BEGIN
  DROP TABLE IF EXISTS _pppo;
  CREATE TEMP TABLE _pppo ON COMMIT DROP AS
  SELECT o.pack_nft_id, o.moments_pulled, o.nft_ids
    FROM public.pinnacle_pack_opens o
   WHERE o.pull_value_usd IS NULL AND o.moments_pulled > 0
     AND (o.priced_at IS NULL OR o.priced_at < now() - interval '6 hours')
   ORDER BY o.opened_at DESC NULLS LAST
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 3000), 1), 10000);
  GET DIAGNOSTICS v_cand = ROW_COUNT;

  WITH pulls AS (
    SELECT c.pack_nft_id, c.moments_pulled, u.nft_id
      FROM _pppo c CROSS JOIN LATERAL unnest(c.nft_ids) AS u(nft_id)
  ), pv AS (
    SELECT p.pack_nft_id, SUM(pc.fmv_usd)::numeric(14,2) AS v
      FROM pulls p
      LEFT JOIN public.pinnacle_mint_events m ON m.nft_id = p.nft_id
      LEFT JOIN public.pinnacle_catalog pc ON pc.render_id = m.render_id
     GROUP BY p.pack_nft_id, p.moments_pulled
    HAVING count(*) = count(pc.fmv_usd) AND count(*) = p.moments_pulled
  ), upd AS (
    UPDATE public.pinnacle_pack_opens o SET pull_value_usd = pv.v, priced_at = now()
      FROM pv WHERE o.pack_nft_id = pv.pack_nft_id AND o.pull_value_usd IS NULL AND pv.v > 0
    RETURNING 1
  )
  SELECT count(*) INTO v_priced FROM upd;

  UPDATE public.pinnacle_pack_opens o SET priced_at = now()
    FROM _pppo c WHERE o.pack_nft_id = c.pack_nft_id AND o.pull_value_usd IS NULL;

  SELECT count(*) INTO v_left FROM public.pinnacle_pack_opens WHERE pull_value_usd IS NULL;
  RETURN jsonb_build_object('candidates', v_cand, 'priced', v_priced, 'still_null', v_left);
END
$fn$;
REVOKE ALL ON FUNCTION public.price_pinnacle_pack_opens(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.price_pinnacle_pack_opens(integer) TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.run_price_pinnacle_pack_opens()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_started timestamptz := clock_timestamp(); v jsonb; v_err text;
BEGIN
  BEGIN
    v := public.price_pinnacle_pack_opens(3000);
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    v_err := SQLERRM;
  END;
  PERFORM public.log_pipeline_run('price-pinnacle-pack-opens', v_started,
    (v->>'candidates')::int, (v->>'priced')::int, NULL, v_err IS NULL, v_err, 'disney_pinnacle', NULL, NULL,
    COALESCE(v, '{}'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.run_price_pinnacle_pack_opens() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_price_pinnacle_pack_opens() TO service_role, postgres;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_gate_key__ingest-pinnacle-pack-opens') THEN
    PERFORM vault.create_secret(
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_gate_key__backfill-topshot-pack-sales'),
      'cron_gate_key__ingest-pinnacle-pack-opens',
      'Copy of the pack-sales lane key; the function reads PACK_SALES_GATE_KEY.'
    );
  END IF;
END $$;

SELECT cron.schedule(
  'rpc-pinnacle-pack-opens-ingest',
  '12,27,42,57 * * * *',
  $cmd$ SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/ingest-pinnacle-pack-opens?key=' || public.cron_gate_key('ingest-pinnacle-pack-opens') || '&pages=30', timeout_milliseconds:=55000); $cmd$
);
SELECT cron.schedule('rpc-price-pinnacle-pack-opens', '16,46 * * * *', 'SELECT public.run_price_pinnacle_pack_opens();');

INSERT INTO public.edge_lane_watch (jobname, fn_name, outcome_table, outcome_column, max_age_hours, severity, note, observed_via, pipeline_name)
VALUES ('rpc-pinnacle-pack-opens-ingest', 'ingest-pinnacle-pack-opens', NULL, NULL, NULL, 'warn',
        'Pinnacle opens in the index can go quiet for weeks (newest 2026-08-21 at build), so opened_at freshness would false-alarm; the lane logs itself.',
        'pipeline_runs', 'pinnacle-pack-opens-ingest')
ON CONFLICT DO NOTHING;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, max_minutes_without_success)
VALUES ('pinnacle-pack-opens-ingest', 60, 'medium', 'Seeded 2026-09-23: pg_cron every 15 min -> 4x silent.', 120),
       ('price-pinnacle-pack-opens', 120, 'info', 'Seeded 2026-09-23: pg_cron every 30 min -> 4x silent.', 240)
ON CONFLICT (pipeline) DO NOTHING;

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
           count(*) FILTER (WHERE o.opened_at > now() - interval '24 hours')::int,
           count(*) FILTER (WHERE o.opened_at > now() - interval '7 days')::int,
           (SELECT max(opened_at) FROM public.pinnacle_pack_opens),
           round(100.0 * count(*) FILTER (WHERE o.dist_id IS NOT NULL) / NULLIF(count(*), 0), 1),
           round(100.0 * count(*) FILTER (WHERE o.pull_value_usd > 0) / NULLIF(count(*), 0), 1)
      FROM public.pinnacle_pack_opens o WHERE o.opened_at > now() - interval '30 days'
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
           WHEN 'disney-pinnacle' THEN 'Packs are sold off-chain: no pack sales feed exists. Opens from Dapper''s PackNFT index (status Opened; the opener is the custodial contract, so unattributed).'
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

DROP VIEW IF EXISTS public.v_pinnacle_mint_batches;
