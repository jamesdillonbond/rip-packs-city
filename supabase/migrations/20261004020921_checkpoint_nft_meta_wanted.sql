-- 2026-10-03 (PT) — Scope the checkpoint NFT-meta load to the NFTs that need it.
--
-- WHY. A mainnet-28 checkpoint decodes to ~60M NFTs (Top Shot alone has minted 50M+); the
-- Flowty-venue history needs a few million of them. Loading all would add ~6 GB to a
-- disk-IO-bound instance for rows nothing reads. checkpoint_nft_meta_wanted is the set of
-- (collection kind, nft_id) the Flowty archive actually sold — every distinct NFT in
-- flowty_archive.flowty_index_sales and flowty_archive.flowty_chain_listing_completed for
-- TS / AD / GZ / UFC — and the loader keeps only those (Top Shot subedition entries follow
-- the 'ts' set). Refill it (INSERT ... ON CONFLICT DO NOTHING from the same two tables) and
-- re-dispatch the workflow to cover NFTs found later; the load is an idempotent upsert.
--
-- Revert: DROP FUNCTION public.checkpoint_nft_meta_wanted_page(text, bigint, integer);
--         DROP TABLE flowty_archive.checkpoint_nft_meta_wanted;

CREATE TABLE IF NOT EXISTS flowty_archive.checkpoint_nft_meta_wanted (
  c       text   NOT NULL CHECK (c IN ('ts', 'ad', 'gz', 'ufc')),
  nft_id  bigint NOT NULL,
  PRIMARY KEY (c, nft_id)
);
ALTER TABLE flowty_archive.checkpoint_nft_meta_wanted ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flowty_archive.checkpoint_nft_meta_wanted FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE flowty_archive.checkpoint_nft_meta_wanted IS
  'NFTs the Flowty archive sold (TS/AD/GZ/UFC): the scope of the checkpoint_nft_meta load. Migration 20261004030000.';

-- One page of wanted ids as a single ARRAY row (a set-returning RPC is clamped at PostgREST's
-- 1000-row cap; an array in one row is not). Keyset-paged on the primary key.
CREATE OR REPLACE FUNCTION public.checkpoint_nft_meta_wanted_page(p_c text, p_after bigint, p_limit integer)
RETURNS bigint[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $f$
  SELECT COALESCE(array_agg(nft_id ORDER BY nft_id), '{}'::bigint[])
    FROM (SELECT w.nft_id FROM flowty_archive.checkpoint_nft_meta_wanted w
           WHERE w.c = p_c AND w.nft_id > p_after
           ORDER BY w.nft_id LIMIT least(greatest(p_limit, 1), 200000)) s
$f$;

REVOKE ALL ON FUNCTION public.checkpoint_nft_meta_wanted_page(text, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_nft_meta_wanted_page(text, bigint, integer) TO service_role;
