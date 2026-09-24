-- 2026-09-23 · LaLiga Golazos pack OPENS (new) + their pull values, and a
-- Disney Pinnacle "mint batch" view as the honest stand-in for Pinnacle opens.
--
-- GOLAZOS: RPC held zero Golazos pack opens (pack_rips = Top Shot + All Day).
-- Dapper's PackNFT index answers 78,825 opened Golazos packs with dist_id,
-- owner and the pulled NFT ids; edge fn ingest-golazos-pack-opens walks it
-- newest-first (head) + history sweep, and names every pull by edition via
-- searchGolazosNft. A separate table, not pack_rips: pack_rips is UNIQUE on
-- pack_nft_id alone and Golazos ids ("1", "2", …) collide with All Day's.
-- price_golazos_pack_opens() fills pull_value_usd with pack_rips' rule:
-- ALL-OR-NOTHING, WHOLE-PACK (every pull named, every edition priced, pulls =
-- moments_pulled), NULL -> positive only.
--
-- PINNACLE: packs are sold off-chain (the PackNFT type answers totalCount 0 in
-- Dapper's index and has no marketplace history), so there is no pack NFT to
-- index. What IS on chain is the mint: one transaction minting several pins to
-- one wallet. v_pinnacle_mint_batches groups pinnacle_mint_events by tx and
-- says in its name and comment what it is — an INFERRED open, not a pack record.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-golazos-pack-opens-ingest');
--   SELECT cron.unschedule('rpc-price-golazos-pack-opens');
--   DELETE FROM public.edge_lane_watch WHERE fn_name = 'ingest-golazos-pack-opens';
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('golazos-pack-opens-ingest','price-golazos-pack-opens');
--   DELETE FROM vault.secrets WHERE name = 'cron_gate_key__ingest-golazos-pack-opens';
--   DROP VIEW public.v_pinnacle_mint_batches;
--   DROP FUNCTION public.run_price_golazos_pack_opens(); DROP FUNCTION public.price_golazos_pack_opens(integer);
--   DROP TABLE public.golazos_pack_open_pulls, public.golazos_pack_opens, public.golazos_pack_opens_cursor;
--
-- anon-exec: NOT intentional for price_golazos_pack_opens / run_price_golazos_pack_opens — ops writers, ACL set below.

CREATE TABLE IF NOT EXISTS public.golazos_pack_opens (
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
CREATE INDEX IF NOT EXISTS idx_golazos_pack_opens_dist ON public.golazos_pack_opens (dist_id);
CREATE INDEX IF NOT EXISTS idx_golazos_pack_opens_opened ON public.golazos_pack_opens (opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_golazos_pack_opens_opener ON public.golazos_pack_opens (opener_address, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_golazos_pack_opens_unpriced ON public.golazos_pack_opens (opened_at DESC) WHERE pull_value_usd IS NULL;

CREATE TABLE IF NOT EXISTS public.golazos_pack_open_pulls (
  nft_id               text PRIMARY KEY,
  pack_nft_id          text NOT NULL,
  edition_external_id  text,
  serial_number        integer,
  ingested_at          timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_golazos_pack_open_pulls_pack ON public.golazos_pack_open_pulls (pack_nft_id);
CREATE INDEX IF NOT EXISTS idx_golazos_pack_open_pulls_edition ON public.golazos_pack_open_pulls (edition_external_id);

CREATE TABLE IF NOT EXISTS public.golazos_pack_opens_cursor (
  id           smallint PRIMARY KEY DEFAULT 1,
  after_cursor text,
  done         boolean DEFAULT false,
  total_seen   bigint,
  updated_at   timestamptz DEFAULT now()
);

ALTER TABLE public.golazos_pack_opens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.golazos_pack_open_pulls   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.golazos_pack_opens_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.golazos_pack_opens, public.golazos_pack_open_pulls, public.golazos_pack_opens_cursor FROM anon, authenticated;
GRANT SELECT ON public.golazos_pack_opens, public.golazos_pack_open_pulls, public.golazos_pack_opens_cursor TO anon, authenticated;

DROP TRIGGER IF EXISTS trg_suppress_redundant_updates ON public.golazos_pack_opens;
CREATE TRIGGER trg_suppress_redundant_updates BEFORE UPDATE ON public.golazos_pack_opens
  FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();
DROP TRIGGER IF EXISTS trg_suppress_redundant_updates ON public.golazos_pack_open_pulls;
CREATE TRIGGER trg_suppress_redundant_updates BEFORE UPDATE ON public.golazos_pack_open_pulls
  FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();

COMMENT ON TABLE public.golazos_pack_opens IS
  'LaLiga Golazos pack opens from Dapper searchPackNft (status Opened). opener_address = owner of the opened PackNFT; opened_at/open_tx = its last update (the reveal). Written by edge fn ingest-golazos-pack-opens; pull_value_usd by price_golazos_pack_opens (whole-pack, all-or-nothing). 2026-09-23.';

CREATE OR REPLACE FUNCTION public.price_golazos_pack_opens(p_limit integer DEFAULT 3000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_gz uuid := '06248cc4-b85f-47cd-af67-1855d14acd75';
  v_cand int := 0; v_priced int := 0; v_left int := 0;
BEGIN
  DROP TABLE IF EXISTS _pgpo;
  CREATE TEMP TABLE _pgpo ON COMMIT DROP AS
  SELECT o.pack_nft_id, o.moments_pulled
    FROM public.golazos_pack_opens o
   WHERE o.pull_value_usd IS NULL AND o.moments_pulled > 0
     AND (o.priced_at IS NULL OR o.priced_at < now() - interval '6 hours')
   ORDER BY o.opened_at DESC NULLS LAST
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 3000), 1), 10000);
  GET DIAGNOSTICS v_cand = ROW_COUNT;

  WITH pv AS (
    SELECT c.pack_nft_id, SUM(fc.fmv_usd)::numeric(14,2) AS v
      FROM _pgpo c
      JOIN public.golazos_pack_open_pulls p ON p.pack_nft_id = c.pack_nft_id
      LEFT JOIN public.editions e ON e.collection_id = v_gz AND e.external_id = p.edition_external_id
      LEFT JOIN LATERAL (
        SELECT s.fmv_usd FROM public.fmv_snapshots s
         WHERE s.edition_id = e.id ORDER BY s.computed_at DESC LIMIT 1
      ) fc ON true
     GROUP BY c.pack_nft_id, c.moments_pulled
    HAVING count(*) = count(fc.fmv_usd) AND count(*) = c.moments_pulled
  ), upd AS (
    UPDATE public.golazos_pack_opens o SET pull_value_usd = pv.v, priced_at = now()
      FROM pv WHERE o.pack_nft_id = pv.pack_nft_id AND o.pull_value_usd IS NULL AND pv.v > 0
    RETURNING 1
  )
  SELECT count(*) INTO v_priced FROM upd;

  -- Stamp the rest so the next pass rotates to other packs (6 h back-off).
  UPDATE public.golazos_pack_opens o SET priced_at = now()
    FROM _pgpo c WHERE o.pack_nft_id = c.pack_nft_id AND o.pull_value_usd IS NULL;

  SELECT count(*) INTO v_left FROM public.golazos_pack_opens WHERE pull_value_usd IS NULL;
  RETURN jsonb_build_object('candidates', v_cand, 'priced', v_priced, 'still_null', v_left);
END
$fn$;
REVOKE ALL ON FUNCTION public.price_golazos_pack_opens(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.price_golazos_pack_opens(integer) TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.run_price_golazos_pack_opens()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_started timestamptz := clock_timestamp(); v jsonb; v_err text;
BEGIN
  BEGIN
    v := public.price_golazos_pack_opens(3000);
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    v_err := SQLERRM;
  END;
  PERFORM public.log_pipeline_run('price-golazos-pack-opens', v_started,
    (v->>'candidates')::int, (v->>'priced')::int, NULL, v_err IS NULL, v_err, 'laliga_golazos', NULL, NULL,
    COALESCE(v, '{}'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.run_price_golazos_pack_opens() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_price_golazos_pack_opens() TO service_role, postgres;

-- Pinnacle: a transaction minting pins to one wallet — an INFERRED pack open.
CREATE OR REPLACE VIEW public.v_pinnacle_mint_batches WITH (security_invoker = on) AS
SELECT m.tx_hash,
       min(m.to_wallet)            AS to_wallet,
       min(m.minted_at)            AS minted_at,
       min(m.block_height)         AS block_height,
       count(*)::int               AS pins_minted,
       count(DISTINCT m.to_wallet)::int AS distinct_wallets
  FROM public.pinnacle_mint_events m
 GROUP BY m.tx_hash;
COMMENT ON VIEW public.v_pinnacle_mint_batches IS
  'Disney Pinnacle mint transactions grouped by tx. Pinnacle packs are sold off-chain (no PackNFT in Dapper''s index, no pack marketplace history), so a multi-pin mint to one wallet is the closest on-chain trace of a pack open. INFERRED, not a pack record. 2026-09-23.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_gate_key__ingest-golazos-pack-opens') THEN
    PERFORM vault.create_secret(
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_gate_key__backfill-topshot-pack-sales'),
      'cron_gate_key__ingest-golazos-pack-opens',
      'Copy of the pack-sales lane key; the function reads PACK_SALES_GATE_KEY.'
    );
  END IF;
END $$;

SELECT cron.schedule(
  'rpc-golazos-pack-opens-ingest',
  '11,26,41,56 * * * *',
  $cmd$ SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/ingest-golazos-pack-opens?key=' || public.cron_gate_key('ingest-golazos-pack-opens') || '&pages=20', timeout_milliseconds:=55000); $cmd$
);
SELECT cron.schedule('rpc-price-golazos-pack-opens', '14,44 * * * *', 'SELECT public.run_price_golazos_pack_opens();');

INSERT INTO public.edge_lane_watch (jobname, fn_name, outcome_table, outcome_column, max_age_hours, severity, note, observed_via, pipeline_name)
VALUES ('rpc-golazos-pack-opens-ingest', 'ingest-golazos-pack-opens', NULL, NULL, NULL, 'warn',
        'Golazos opens are rare (newest 2026-09-14 at build), so opened_at freshness would be permanently stale; the lane logs itself.',
        'pipeline_runs', 'golazos-pack-opens-ingest')
ON CONFLICT DO NOTHING;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, max_minutes_without_success)
VALUES ('golazos-pack-opens-ingest', 60, 'medium', 'Seeded 2026-09-23: pg_cron every 15 min -> 4x silent.', 120),
       ('price-golazos-pack-opens', 120, 'info', 'Seeded 2026-09-23: pg_cron every 30 min -> 4x silent.', 240)
ON CONFLICT (pipeline) DO NOTHING;
