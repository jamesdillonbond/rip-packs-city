-- 2026-09-23 · One pack-metrics layer across all SEVEN collections, with history.
--
-- get_pack_metrics() answers, per collection, the six pack metrics Trevor asked to
-- drive — EV coverage + availability, sales, opens, "collection" (named dists),
-- P&L value coverage — from each collection's own sources:
--   Top Shot / All Day : pack_table_rows, *_pack_sales_history, pack_rips, pack_purchases
--   LaLiga Golazos     : pack_table_rows, golazos_pack_sales_history, golazos_pack_opens (both new today)
--   Disney Pinnacle    : pack_table_rows; opens = v_pinnacle_mint_batches (INFERRED — packs are
--                        sold off-chain, so there are no pack sales to count)
--   Candy MLB          : candy_pack_sales, candy_packs, candy_pack_market, candy_pack_ev_model
--   Panini             : panini_pack_ev_board / panini_pack_state (+ the new history below)
-- A metric a collection has no source for is NULL with a note saying why — never 0.
--
-- pack_metrics_snapshots keeps an hourly copy, so every one of these becomes a
-- trend line (the board reads it). panini_pack_state is overwritten in place by
-- the Panini runner, which threw away every earlier floor / remaining count;
-- panini_pack_state_history now keeps a row per CHANGE (trigger), which is the
-- only Panini pack-sales/opens history RPC can have (Panini's pack sales come as
-- stats, not a transaction feed).
--
-- REVERT:
--   SELECT cron.unschedule('rpc-pack-metrics-snapshot');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'pack-metrics-snapshot';
--   DROP TRIGGER trg_panini_pack_state_history ON public.panini_pack_state;
--   DROP FUNCTION public.panini_pack_state_history_trg();
--   DROP FUNCTION public.run_pack_metrics_snapshot(); DROP FUNCTION public.get_pack_metrics();
--   DROP TABLE public.pack_metrics_snapshots, public.panini_pack_state_history;
--
-- anon-exec: NOT intentional for run_pack_metrics_snapshot — ops writer. get_pack_metrics is
-- read-only aggregate counts over public-SELECT tables; granted to service_role only (the board
-- reads it through the MCP), ACL set below.

CREATE TABLE IF NOT EXISTS public.panini_pack_state_history (
  id              text NOT NULL,
  observed_at     timestamptz NOT NULL DEFAULT now(),
  pack_type       text,
  price_usd       numeric,
  packs_total     integer,
  packs_remaining integer,
  floor_usd       numeric,
  avg_sale_usd    numeric,
  recent_sale_usd numeric,
  top_sale_usd    numeric,
  PRIMARY KEY (id, observed_at)
);
ALTER TABLE public.panini_pack_state_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_pack_state_history FROM anon, authenticated;
GRANT SELECT ON public.panini_pack_state_history TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.panini_pack_state_history_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.packs_remaining IS DISTINCT FROM OLD.packs_remaining
     OR NEW.floor_usd       IS DISTINCT FROM OLD.floor_usd
     OR NEW.avg_sale_usd    IS DISTINCT FROM OLD.avg_sale_usd
     OR NEW.recent_sale_usd IS DISTINCT FROM OLD.recent_sale_usd
     OR NEW.top_sale_usd    IS DISTINCT FROM OLD.top_sale_usd
     OR NEW.price_usd       IS DISTINCT FROM OLD.price_usd THEN
    INSERT INTO public.panini_pack_state_history
      (id, observed_at, pack_type, price_usd, packs_total, packs_remaining, floor_usd, avg_sale_usd, recent_sale_usd, top_sale_usd)
    VALUES (NEW.id, COALESCE(NEW.updated_at, now()), NEW.pack_type, NEW.price_usd, NEW.packs_total, NEW.packs_remaining,
            NEW.floor_usd, NEW.avg_sale_usd, NEW.recent_sale_usd, NEW.top_sale_usd)
    ON CONFLICT (id, observed_at) DO NOTHING;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.panini_pack_state_history_trg() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_panini_pack_state_history ON public.panini_pack_state;
CREATE TRIGGER trg_panini_pack_state_history
  AFTER INSERT OR UPDATE ON public.panini_pack_state
  FOR EACH ROW EXECUTE FUNCTION public.panini_pack_state_history_trg();

-- seed the history with today's state
INSERT INTO public.panini_pack_state_history
  (id, observed_at, pack_type, price_usd, packs_total, packs_remaining, floor_usd, avg_sale_usd, recent_sale_usd, top_sale_usd)
SELECT id, COALESCE(updated_at, now()), pack_type, price_usd, packs_total, packs_remaining, floor_usd, avg_sale_usd, recent_sale_usd, top_sale_usd
  FROM public.panini_pack_state
ON CONFLICT DO NOTHING;

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

CREATE TABLE IF NOT EXISTS public.pack_metrics_snapshots (
  captured_at timestamptz NOT NULL DEFAULT now(),
  collection_slug text NOT NULL,
  metrics jsonb NOT NULL,
  PRIMARY KEY (captured_at, collection_slug)
);
ALTER TABLE public.pack_metrics_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_metrics_snapshots FROM anon, authenticated;
GRANT SELECT ON public.pack_metrics_snapshots TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.run_pack_metrics_snapshot()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_started timestamptz := clock_timestamp(); v_n int := 0; v_err text;
BEGIN
  BEGIN
    INSERT INTO public.pack_metrics_snapshots (captured_at, collection_slug, metrics)
    SELECT date_trunc('minute', now()), m.collection_slug, to_jsonb(m) - 'collection_slug'
      FROM public.get_pack_metrics() m
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    v_err := SQLERRM;
  END;
  PERFORM public.log_pipeline_run('pack-metrics-snapshot', v_started, 7, v_n, NULL, v_err IS NULL AND v_n = 7,
    COALESCE(v_err, CASE WHEN v_n <> 7 THEN v_n || ' of 7 collections written' END), NULL, NULL, NULL,
    jsonb_build_object('rows', v_n));
END
$fn$;
REVOKE ALL ON FUNCTION public.run_pack_metrics_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_pack_metrics_snapshot() TO service_role, postgres;

SELECT cron.schedule('rpc-pack-metrics-snapshot', '17 * * * *', 'SELECT public.run_pack_metrics_snapshot();');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, max_minutes_without_success)
VALUES ('pack-metrics-snapshot', 180, 'info', 'Seeded 2026-09-23: pg_cron hourly -> 3x silent.', 360)
ON CONFLICT (pipeline) DO NOTHING;
