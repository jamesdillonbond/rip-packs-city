-- 2026-10-03 (PT) — Holder-independent NFT -> edition/serial map for Top Shot, All Day,
-- Golazos and UFC Strike, decoded from a Flow spork-root CHECKPOINT (the full ledger state).
--
-- WHY. Incorporating Flowty-venue history (flowty_archive.flowty_chain_listing_completed,
-- 2023-11..2025-12) needs each sold NFT's edition. Measured 2026-10-03 on a 2% sample of those
-- sales: RPC's own maps name only ~32% of the Top Shot NFTs (topshot_moment_id_editions) and
-- ~5% of the All Day ones (nft_edition_map) — they only know moments RPC has seen held or
-- sold. A checkpoint holds EVERY existing NFT with its MomentData / editionID / serial,
-- whoever owns it. Decoder: scripts/flow-checkpoint/ckpt_nftmeta.py (Cadence-1.0 atree:
-- inlined composites, field order read from each slab's own type info). Loaded by
-- .github/workflows/checkpoint-nft-meta-load.yml through ingest_checkpoint_nft_meta().
--
-- ROW (raw, as decoded; resolution to editions.id happens in SQL at use):
--   c='ts'    a=setID  b=playID   serial        -> editions.external_id 'a:b' (+ '::sub' below)
--   c='tssub' a=subeditionID                    TopShot SubEditionAdmin.momentsSubedition entry;
--                                               0 / absent = Standard printing
--   c='ad'|'gz' a=editionID       serial        -> editions.external_id 'a'
--   c='ufc'   a=setId             serial=editionNum (UFC editions are slug-keyed: map setId
--                                               via NFTs already in nft_edition_map)
-- Controls on a 128 MB slice of mainnet-28 part 005 vs RPC's independent tables: TS set:play
-- 6/6, TS serial 3/3, TS subedition 7/7, AD edition 9/9 + serial 7/7, UFC serial 6/6.
--
-- Revert: DROP FUNCTION public.ingest_checkpoint_nft_meta(jsonb); DROP TABLE public.checkpoint_nft_meta;

CREATE TABLE IF NOT EXISTS public.checkpoint_nft_meta (
  spork      smallint    NOT NULL,
  c          text        NOT NULL CHECK (c IN ('ts', 'tssub', 'ad', 'gz', 'ufc')),
  nft_id     bigint      NOT NULL,
  a          bigint,
  b          bigint,
  serial     bigint,
  loaded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (c, nft_id, spork)
);

COMMENT ON TABLE public.checkpoint_nft_meta IS
  'NFT -> edition/serial for TS/AD/GZ/UFC decoded from a Flow spork-root checkpoint (any owner). See migration header for the a/b meaning per c. Loader: .github/workflows/checkpoint-nft-meta-load.yml.';

ALTER TABLE public.checkpoint_nft_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.checkpoint_nft_meta FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ingest_checkpoint_nft_meta(p_rows jsonb)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $f$
  WITH ins AS (
    INSERT INTO public.checkpoint_nft_meta (spork, c, nft_id, a, b, serial)
    SELECT (r->>'spork')::smallint, r->>'c', (r->>'id')::bigint,
           COALESCE(r->>'set', r->>'ed', r->>'sub')::bigint, (r->>'play')::bigint, (r->>'serial')::bigint
      FROM jsonb_array_elements(p_rows) r
    ON CONFLICT (c, nft_id, spork) DO UPDATE
      SET a = EXCLUDED.a, b = EXCLUDED.b, serial = EXCLUDED.serial, loaded_at = now()
    RETURNING 1)
  SELECT count(*)::integer FROM ins
$f$;

REVOKE ALL ON FUNCTION public.ingest_checkpoint_nft_meta(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_checkpoint_nft_meta(jsonb) TO service_role;
