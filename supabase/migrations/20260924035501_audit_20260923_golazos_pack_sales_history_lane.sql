-- 2026-09-23 · LaLiga Golazos pack SALES history — the third Dapper-studio pack-sales lane.
--
-- Dapper studio `searchPackMarketplaceHistory` answers for Golazos' PackNFT type
-- (A.87ca73a41bb50ad5.PackNFT.NFT): totalCount 31,846 on 2026-09-23, per-sale
-- dist_id + status. Nothing in RPC held Golazos pack sales before this. (Disney
-- Pinnacle's PackNFT answers totalCount 0 on the same endpoint, so it gets no lane.)
--
-- Same shape as topshot_/allday_pack_sales_history, incl. the no-op-UPDATE
-- suppression trigger (20260922193435) and the anon SELECT grant.
-- Gate: pg_cron sends public.cron_gate_key('backfill-golazos-pack-sales'); the
-- Vault secret is created here by COPYING the Top Shot lane's secret in-DB (all
-- three functions read the project-wide PACK_SALES_GATE_KEY), so no key is ever
-- selected, transcribed or committed.
--
-- Revert:
--   SELECT cron.unschedule('rpc-golazos-pack-sales-backfill');
--   DELETE FROM public.edge_lane_watch WHERE fn_name = 'backfill-golazos-pack-sales';
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'golazos-pack-sales-ingest';
--   DELETE FROM vault.secrets WHERE name = 'cron_gate_key__backfill-golazos-pack-sales';
--   DROP TABLE public.golazos_pack_sales_history, public.golazos_pack_sales_cursor;

CREATE TABLE IF NOT EXISTS public.golazos_pack_sales_history (
  tx_hash             text NOT NULL,
  pack_nft_id         text NOT NULL,
  listing_resource_id text,
  sale_price_usd      numeric,
  purchased           boolean,
  buyer_address       text,
  storefront_address  text,
  custom_id           text,
  dist_id             text,
  nft_status          text,
  block_height        bigint,
  block_time          timestamptz,
  ingested_at         timestamptz DEFAULT now(),
  CONSTRAINT golazos_pack_sales_history_pkey PRIMARY KEY (tx_hash, pack_nft_id)
);
CREATE INDEX IF NOT EXISTS idx_golazos_pack_sales_hist_dist ON public.golazos_pack_sales_history (dist_id);
CREATE INDEX IF NOT EXISTS idx_golazos_pack_sales_hist_pack ON public.golazos_pack_sales_history (pack_nft_id);
CREATE INDEX IF NOT EXISTS idx_golazos_pack_sales_hist_block_time ON public.golazos_pack_sales_history (block_time);
CREATE INDEX IF NOT EXISTS idx_golazos_pack_sales_hist_buyer ON public.golazos_pack_sales_history (buyer_address, block_time DESC) WHERE purchased;
CREATE INDEX IF NOT EXISTS idx_golazos_pack_sales_hist_seller ON public.golazos_pack_sales_history (storefront_address, block_time DESC) WHERE purchased;

CREATE TABLE IF NOT EXISTS public.golazos_pack_sales_cursor (
  id           smallint PRIMARY KEY DEFAULT 1,
  after_cursor text,
  done         boolean DEFAULT false,
  total_seen   bigint,
  updated_at   timestamptz DEFAULT now()
);

ALTER TABLE public.golazos_pack_sales_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.golazos_pack_sales_cursor  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.golazos_pack_sales_history, public.golazos_pack_sales_cursor FROM anon, authenticated;
GRANT SELECT ON public.golazos_pack_sales_history, public.golazos_pack_sales_cursor TO anon, authenticated;

DROP TRIGGER IF EXISTS trg_suppress_redundant_updates ON public.golazos_pack_sales_history;
CREATE TRIGGER trg_suppress_redundant_updates
  BEFORE UPDATE ON public.golazos_pack_sales_history
  FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();

COMMENT ON TABLE public.golazos_pack_sales_history IS
  'LaLiga Golazos pack marketplace sales from Dapper studio searchPackMarketplaceHistory. Written by edge fn backfill-golazos-pack-sales (head-first walker, pipeline golazos-pack-sales-ingest). sale_price_usd = UFix64/1e8. ingested_at = first insert (updates are suppressed when nothing changed).';

-- Vault secret: copy, never select.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_gate_key__backfill-golazos-pack-sales') THEN
    PERFORM vault.create_secret(
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_gate_key__backfill-topshot-pack-sales'),
      'cron_gate_key__backfill-golazos-pack-sales',
      'Copy of the Top Shot pack-sales lane key; all three pack-sales functions read PACK_SALES_GATE_KEY.'
    );
  END IF;
END $$;

-- Every 15 min, off the :00/:20/:40 marks and off jobs 25/29's */3 grid minutes.
SELECT cron.schedule(
  'rpc-golazos-pack-sales-backfill',
  '8,23,38,53 * * * *',
  $cmd$ SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/backfill-golazos-pack-sales?key=' || public.cron_gate_key('backfill-golazos-pack-sales') || '&pages=30', timeout_milliseconds:=55000); $cmd$
);

INSERT INTO public.edge_lane_watch (jobname, fn_name, outcome_table, outcome_column, max_age_hours, severity, note, observed_via, pipeline_name)
VALUES ('rpc-golazos-pack-sales-backfill', 'backfill-golazos-pack-sales', NULL, NULL, NULL, 'warn',
        'Golazos pack market is thin (newest sale can be months old), so block_time freshness would be permanently stale; the lane logs itself as golazos-pack-sales-ingest, which is what this row verifies.',
        'pipeline_runs', 'golazos-pack-sales-ingest')
ON CONFLICT DO NOTHING;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, max_minutes_without_success)
VALUES
  ('golazos-pack-sales-ingest', 60, 'medium', 'Seeded 2026-09-23 with the lane: pg_cron 15-min cadence -> 4x silent.', 120),
  ('topshot-pack-sales-ingest', 20, 'medium', 'Seeded 2026-09-23: head-first walker, pg_cron every 3 min -> ~6x silent. First self-log this lane has ever written (R110).', 45),
  ('allday-pack-sales-ingest',  20, 'medium', 'Seeded 2026-09-23: head-first walker, pg_cron every 3 min -> ~6x silent. First self-log this lane has ever written (R110).', 45)
ON CONFLICT (pipeline) DO NOTHING;
