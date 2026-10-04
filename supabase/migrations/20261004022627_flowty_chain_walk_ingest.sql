-- 2026-10-03 (PT) — The Flowty chain-verification walk runs on GitHub Actions, not pg_net.
--
-- WHY. Run from pg_cron + pg_net (scripts/flowty-export/chain_walk.sql), a /v1/events window
-- on the history nodes takes tens of seconds and pg_net's worker waits for its whole batch:
-- with 80 walk requests in flight the shared queue reached 104 and no response landed for
-- 41 s — every production lane on pg_net stalls behind it. Measured 2026-10-03 ~7:25 PM PT
-- and stopped (no production lane recorded a timeout). The walk now runs on GHA runners
-- (.github/workflows/flowty-chain-walk.yml, scripts/flowty-export/chain_walk_gha.py), which
-- reach the nodes directly, each with its own egress rate budget, and write back here.
--
-- COVERAGE IS PROVED, NOT ASSUMED: a window is recorded in flowty_chain_walk_coverage only in
-- the same statement that lands its events, and only after the node answered 200 for it.
-- The walk is complete over [65,264,619 .. 137,390,145] iff every 250-block window is there.
--
-- Revert: DROP FUNCTION public.ingest_flowty_chain_walk(jsonb, jsonb);
--         DROP TABLE flowty_archive.flowty_chain_walk_coverage;

CREATE TABLE IF NOT EXISTS flowty_archive.flowty_chain_walk_coverage (
  win_start  bigint      PRIMARY KEY,
  win_end    bigint      NOT NULL,
  n_events   integer     NOT NULL,
  n_purchased integer    NOT NULL,
  walked_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE flowty_archive.flowty_chain_walk_coverage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flowty_archive.flowty_chain_walk_coverage FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE flowty_archive.flowty_chain_walk_coverage IS
  'One row per 250-block window of the Flowty NFTStorefrontV2 ListingCompleted walk that a Flow history node answered 200 for; written atomically with its events. Migration 20261004031500.';

-- p_events: [{tx_hash, event_index, block_height, block_ts, listing_resource_id, ...}]
-- p_windows: [{win_start, win_end, n_events, n_purchased}]
-- Returns {"events": rows inserted (0 on a replay), "windows": windows recorded}.
CREATE OR REPLACE FUNCTION public.ingest_flowty_chain_walk(p_events jsonb, p_windows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
DECLARE v_ev int; v_win int;
BEGIN
  WITH ins AS (
    INSERT INTO flowty_archive.flowty_chain_listing_completed (tx_hash, event_index, block_height, block_ts,
      listing_resource_id, storefront_resource_id, seller, buyer, nft_type, nft_id, nft_uuid, collection_id,
      price, payment_vault, commission_amount, commission_receiver, custom_id, expiry)
    SELECT e->>'tx_hash', (e->>'event_index')::int, (e->>'block_height')::bigint, (e->>'block_ts')::timestamptz,
      e->>'listing_resource_id', e->>'storefront_resource_id', lower(e->>'seller'), lower(e->>'buyer'),
      e->>'nft_type', e->>'nft_id', e->>'nft_uuid', public.flowty_collection_id_from_nft_type(e->>'nft_type'),
      (e->>'price')::numeric, e->>'payment_vault', (e->>'commission_amount')::numeric,
      lower(e->>'commission_receiver'), e->>'custom_id', (e->>'expiry')::bigint
    FROM jsonb_array_elements(p_events) e
    ON CONFLICT (tx_hash, event_index) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO v_ev FROM ins;

  WITH w AS (
    INSERT INTO flowty_archive.flowty_chain_walk_coverage (win_start, win_end, n_events, n_purchased)
    SELECT (x->>'win_start')::bigint, (x->>'win_end')::bigint, (x->>'n_events')::int, (x->>'n_purchased')::int
    FROM jsonb_array_elements(p_windows) x
    ON CONFLICT (win_start) DO UPDATE SET win_end = EXCLUDED.win_end, n_events = EXCLUDED.n_events,
      n_purchased = EXCLUDED.n_purchased, walked_at = now()
    RETURNING 1)
  SELECT count(*) INTO v_win FROM w;

  RETURN jsonb_build_object('events', v_ev, 'windows', v_win);
END $f$;

REVOKE ALL ON FUNCTION public.ingest_flowty_chain_walk(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_flowty_chain_walk(jsonb, jsonb) TO service_role;
