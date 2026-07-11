-- Applied 2026-07-11 via Supabase MCP apply_migration.
-- Backing store for the Dapper studio-platform searchPackNft historical
-- pack-opens backfill (edge fn `backfill-pack-opens-api`) that completes
-- pack_rips for Top Shot + NFL All Day back to PackNFT genesis, bypassing the
-- spork-floor pruning that caps the on-chain block-scan opens backfills.

CREATE TABLE IF NOT EXISTS public.pack_opens_api_state (
  collection_id uuid PRIMARY KEY REFERENCES public.collections(id),
  type_name     text NOT NULL,
  after_cursor  text,                 -- null = start from beginning
  packs_seen    bigint NOT NULL DEFAULT 0,
  rips_written  bigint NOT NULL DEFAULT 0,
  total_opened  bigint,               -- API totalCount snapshot (opened packs universe)
  done          boolean NOT NULL DEFAULT false,
  last_status   text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pack_opens_api_state ENABLE ROW LEVEL SECURITY;
-- service_role-only (bypasses RLS); no anon/authenticated policy by design.

COMMENT ON TABLE public.pack_opens_api_state IS
  'Cursor/progress for backfill-pack-opens-api (Dapper searchPackNft -> pack_rips). Reaches PackNFT genesis (2022 AllDay / 2023 TopShot), bypassing spork-floor pruning that caps the on-chain block-scan opens backfills.';

-- Idempotent set-based upsert of pack_rips rows sourced from searchPackNft.
-- tx_hash = the pack's metadata_updated_at.transaction_hash, which equals the
-- real on-chain OPEN tx (validated 2026-07-11 against 4 block-scanned rips) so
-- API rows dedup cleanly against on-chain-scanned rows via idx_pack_rips_pack_nft_id
-- AND idx_pack_rips_tx_hash. On conflict we only backfill dist_id (COALESCE-keep
-- existing) so the API run also fills TopShot rips' historically-null dist_id
-- without clobbering verified on-chain tx/time. Bulk-open siblings (>1 pack per
-- open tx, rare) are dropped to respect idx_pack_rips_tx_hash, matching the
-- existing block-scan behavior. Returns count of NEWLY inserted rips.
CREATE OR REPLACE FUNCTION public.upsert_pack_rips_from_api(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
DECLARE
  v_inserted integer;
BEGIN
  WITH raw AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS x(
      collection_id  uuid,
      pack_nft_id    text,
      opener_address text,
      moments_pulled int,
      tx_hash        text,
      block_height   bigint,
      sealed_at      timestamptz,
      dist_id        text
    )
  ),
  by_pack AS (
    SELECT DISTINCT ON (pack_nft_id) *
    FROM raw
    WHERE pack_nft_id IS NOT NULL AND tx_hash IS NOT NULL
      AND opener_address IS NOT NULL AND sealed_at IS NOT NULL
    ORDER BY pack_nft_id
  ),
  src AS (
    SELECT DISTINCT ON (tx_hash) *
    FROM by_pack
    ORDER BY tx_hash, pack_nft_id
  ),
  ins AS (
    INSERT INTO pack_rips
      (collection_id, pack_nft_id, opener_address, moments_pulled, tx_hash, block_height, sealed_at, dist_id)
    SELECT s.collection_id, s.pack_nft_id, s.opener_address, s.moments_pulled, s.tx_hash, s.block_height, s.sealed_at, s.dist_id
    FROM src s
    WHERE NOT EXISTS (
      SELECT 1 FROM pack_rips pr
      WHERE pr.tx_hash = s.tx_hash AND pr.pack_nft_id <> s.pack_nft_id
    )
    ON CONFLICT (pack_nft_id) DO UPDATE
      SET dist_id = COALESCE(pack_rips.dist_id, EXCLUDED.dist_id)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted) INTO v_inserted FROM ins;
  RETURN COALESCE(v_inserted, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_pack_rips_from_api(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_pack_rips_from_api(jsonb) TO service_role, postgres;
