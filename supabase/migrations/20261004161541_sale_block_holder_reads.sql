-- 2026-10-04 (PT). Name a sold NFT that NO checkpoint holds by reading the buyer's collection at the sale's
-- own block, on the history node of that spork.
--
-- WHY: the Flowty / Dapper promoters name an NFT from public.checkpoint_nft_meta (spork-root checkpoints
-- 25 / 26 / 28 + the 2026 mint-event walk, spork code 128). 46,256 Top Shot, 8,199 All Day and ~4,400 UFC
-- chain-verified sales are of NFTs that were already on the checkpoint wanted list yet appear in NO
-- checkpoint: mostly mainnet24-era sales (2023-11 → 2024-09) of NFTs gone before the mainnet25 root —
-- burned after the sale. No later state can name them; the chain AT THE SALE can.
--
-- HOW (scripts/flowty-export/sale_block_read_gha.py, .github/workflows/sale-block-read.yml): for each
-- candidate, POST /v1/scripts?block_id=<the sale's block> (or block_height) on the spork's history node,
-- borrowing the NFT from the BUYER's public collection — the same read run_topshot_pull_chain_lane() has run
-- since 2026-09-29 (migration 20260929160000), with pre-Cadence-1.0 syntax on mainnet24. Contract surfaces
-- read from the chain 2026-10-04 at a mainnet24 block: TopShot /public/MomentCollection
-- MomentCollectionPublic.borrowMoment + TopShot.getMomentsSubedition; AllDay /public/AllDayNFTCollection
-- MomentNFTCollectionPublic.borrowMomentNFT (editionID, serialNumber); UFC_NFT /public/UFC_NFTCollection
-- UFC_NFTCollectionPublic.borrowUFC_NFT (setId, editionNum).
-- Results land in public.checkpoint_nft_meta as spork code 1 = "holder read at the sale block" through
-- public.ingest_checkpoint_nft_meta — the LOWEST code, so every promoter (latest spork first) prefers a real
-- checkpoint, and this only fills NFTs nothing else names. A read that does not find the NFT (moved within
-- the block, buyer's collection not public) records nothing — never a guessed name.
--
--   flowty_archive.sale_block_read_candidates  one row per (c, nft_id, sale tx); status NULL → 'found' / 'absent'
--   public.sale_block_read_page(after, limit)   unread candidates, key order (service_role)
--   public.ingest_sale_block_reads(rows)         meta rows → checkpoint_nft_meta (spork 1) + candidate status
--
-- Revert: DELETE FROM public.checkpoint_nft_meta WHERE spork = 1;
--         DROP FUNCTION public.ingest_sale_block_reads(jsonb), public.sale_block_read_page(text, integer);
--         DROP TABLE flowty_archive.sale_block_read_candidates;

CREATE TABLE flowty_archive.sale_block_read_candidates (
  k            text PRIMARY KEY,                -- c || ':' || nft_id || ':' || tx_hash
  c            text NOT NULL CHECK (c IN ('ts', 'ad', 'ufc')),
  nft_id       bigint NOT NULL,
  tx_hash      text NOT NULL,
  buyer        text NOT NULL,
  node         text NOT NULL,
  block_id     text,
  block_height bigint,
  block_ts     timestamptz,
  status       text CHECK (status IN ('found', 'absent')),
  read_at      timestamptz,
  CHECK (block_id IS NOT NULL OR block_height IS NOT NULL)
);
CREATE INDEX ON flowty_archive.sale_block_read_candidates (k) WHERE status IS NULL;

CREATE OR REPLACE FUNCTION public.sale_block_read_page(p_after text, p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('k', k, 'c', c, 'id', nft_id, 'buyer', buyer, 'node', node,
                                                'block_id', block_id, 'block_height', block_height) ORDER BY k), '[]'::jsonb)
    FROM (SELECT * FROM flowty_archive.sale_block_read_candidates
           WHERE status IS NULL AND k > p_after ORDER BY k LIMIT least(greatest(p_limit, 1), 2000)) s
$f$;
REVOKE ALL ON FUNCTION public.sale_block_read_page(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sale_block_read_page(text, integer) TO service_role;

-- p_rows: [{k, found (bool), meta: [{c, id, set|ed, play, serial} ...]}]. Meta rows go in as spork 1; the
-- candidate gets its status. Returns {meta, candidates}.
CREATE OR REPLACE FUNCTION public.ingest_sale_block_reads(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
DECLARE v_meta int := 0; v_cand int;
BEGIN
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r, jsonb_array_elements(COALESCE(r->'meta', '[]'::jsonb)) m
              WHERE m->>'c' NOT IN ('ts', 'tssub', 'ad', 'ufc')) THEN
    RAISE EXCEPTION 'meta row with an unknown collection code';
  END IF;
  SELECT public.ingest_checkpoint_nft_meta(COALESCE(jsonb_agg(m || jsonb_build_object('spork', 1)), '[]'::jsonb)) INTO v_meta
    FROM jsonb_array_elements(p_rows) r, jsonb_array_elements(COALESCE(r->'meta', '[]'::jsonb)) m;
  WITH u AS (
    UPDATE flowty_archive.sale_block_read_candidates c
       SET status = CASE WHEN (r->>'found')::boolean THEN 'found' ELSE 'absent' END, read_at = now()
      FROM jsonb_array_elements(p_rows) r
     WHERE c.k = r->>'k' AND c.status IS NULL
    RETURNING 1)
  SELECT count(*) INTO v_cand FROM u;
  RETURN jsonb_build_object('meta', v_meta, 'candidates', v_cand);
END $f$;
REVOKE ALL ON FUNCTION public.ingest_sale_block_reads(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_sale_block_reads(jsonb) TO service_role;
