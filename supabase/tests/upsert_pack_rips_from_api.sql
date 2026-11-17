-- DB invariant: public.upsert_pack_rips_from_api — the batch upsert that lands
-- pack-open ("rip") events from the API backfill into pack_rips. It parses a
-- jsonb array, drops incomplete rows, dedupes WITHIN the batch twice (one row per
-- pack, then one row per tx — the bulk-open guard), drops rows whose tx already
-- belongs to a DIFFERENT pack already in pack_rips (the cross-batch bulk-open
-- guard), and on a pack_nft_id conflict only backfills a missing dist_id
-- (COALESCE, never overwriting one). It returns the count of rows actually
-- INSERTED (not updated). A regression that skips a guard double-lands a
-- bulk-open pack; one that overwrites dist_id loses a resolved distribution.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260711140000_pack_opens_api_backfill_state_and_upsert.sql),
-- with its body verified byte-identical to live prod via pg_get_functiondef on
-- 2026-07-31 (live's header carries a later-ALTERed lock_timeout the migration
-- lacks; the drift guard compares this copy to the migration's CREATE).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pack_rips (
  collection_id  uuid,
  pack_nft_id    text UNIQUE,
  opener_address text,
  moments_pulled int,
  tx_hash        text,
  block_height   bigint,
  sealed_at      timestamptz,
  dist_id        text
);

-- >>> BEGIN verbatim upsert_pack_rips_from_api (body byte-identical to prod) >>>
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
-- <<< END verbatim upsert_pack_rips_from_api <<<

\set c '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

-- ── 1. Complete rows insert; incomplete + within-batch dupes are dropped ─────
SELECT _assert_eq(public.upsert_pack_rips_from_api(jsonb_build_array(
  jsonb_build_object('collection_id', :c, 'pack_nft_id','P1','opener_address','0xO','moments_pulled',3,'tx_hash','T1','block_height',10,'sealed_at','2026-07-30T00:00:00Z'),
  jsonb_build_object('collection_id', :c, 'pack_nft_id','P1','opener_address','0xO','moments_pulled',3,'tx_hash','T1','block_height',10,'sealed_at','2026-07-30T00:00:00Z','dist_id','D1'),
  jsonb_build_object('collection_id', :c, 'pack_nft_id','P2','opener_address','0xO','moments_pulled',5,'tx_hash','T2','block_height',11,'sealed_at','2026-07-30T00:00:00Z'),
  jsonb_build_object('collection_id', :c, 'pack_nft_id','P3','opener_address','0xO','moments_pulled',1,'tx_hash', NULL,'block_height',12,'sealed_at','2026-07-30T00:00:00Z'),
  jsonb_build_object('collection_id', :c, 'pack_nft_id', NULL,'opener_address','0xO','moments_pulled',1,'tx_hash','T4','block_height',13,'sealed_at','2026-07-30T00:00:00Z')
))::text, '2', 'inserts P1+P2 only — incomplete rows (null tx / null pack) dropped, in-batch pack dupe collapsed');
SELECT _assert_eq((SELECT count(*)::text FROM public.pack_rips WHERE pack_nft_id IN ('P1','P2')), '2',
  'exactly P1 and P2 landed');

-- ── 2. Within-batch tx dedup: two DIFFERENT packs sharing a tx → only one ────
SELECT _assert_eq(public.upsert_pack_rips_from_api(jsonb_build_array(
  jsonb_build_object('collection_id', :c, 'pack_nft_id','P4','opener_address','0xO','moments_pulled',2,'tx_hash','TX','block_height',20,'sealed_at','2026-07-30T00:00:00Z'),
  jsonb_build_object('collection_id', :c, 'pack_nft_id','P5','opener_address','0xO','moments_pulled',2,'tx_hash','TX','block_height',20,'sealed_at','2026-07-30T00:00:00Z')
))::text, '1', 'two distinct packs sharing one tx collapse to a single row (bulk-open guard)');
SELECT _assert_eq((SELECT pack_nft_id FROM public.pack_rips WHERE tx_hash='TX'), 'P4',
  'the DISTINCT ON (tx_hash) ORDER BY tx_hash, pack_nft_id keeps the lower pack id (P4)');

-- ── 3. ON CONFLICT only backfills a MISSING dist_id, never overwrites; ret 0 ─
-- P6 lands with dist D_A, then a re-upsert with D_B must NOT overwrite it.
SELECT public.upsert_pack_rips_from_api(jsonb_build_array(
  jsonb_build_object('collection_id', :c, 'pack_nft_id','P6','opener_address','0xO','moments_pulled',4,'tx_hash','T6','block_height',30,'sealed_at','2026-07-30T00:00:00Z','dist_id','D_A')));
SELECT _assert_eq(public.upsert_pack_rips_from_api(jsonb_build_array(
  jsonb_build_object('collection_id', :c, 'pack_nft_id','P6','opener_address','0xO','moments_pulled',4,'tx_hash','T6','block_height',30,'sealed_at','2026-07-30T00:00:00Z','dist_id','D_B')
))::text, '0', 'an existing pack conflict counts as 0 inserted (it was an update)');
SELECT _assert_eq((SELECT dist_id FROM public.pack_rips WHERE pack_nft_id='P6'), 'D_A',
  'COALESCE keeps the existing dist_id — a re-open never overwrites it');

-- P7 lands with NULL dist, a later open supplies one → it is backfilled.
SELECT public.upsert_pack_rips_from_api(jsonb_build_array(
  jsonb_build_object('collection_id', :c, 'pack_nft_id','P7','opener_address','0xO','moments_pulled',4,'tx_hash','T7','block_height',31,'sealed_at','2026-07-30T00:00:00Z')));
SELECT public.upsert_pack_rips_from_api(jsonb_build_array(
  jsonb_build_object('collection_id', :c, 'pack_nft_id','P7','opener_address','0xO','moments_pulled',4,'tx_hash','T7','block_height',31,'sealed_at','2026-07-30T00:00:00Z','dist_id','D_C')));
SELECT _assert_eq((SELECT dist_id FROM public.pack_rips WHERE pack_nft_id='P7'), 'D_C',
  'a NULL dist_id is backfilled from a later open (COALESCE fills the gap)');

-- ── 4. Cross-batch bulk-open guard: a tx already owned by a different pack ────
SELECT _assert_eq(public.upsert_pack_rips_from_api(jsonb_build_array(
  jsonb_build_object('collection_id', :c, 'pack_nft_id','P9','opener_address','0xO','moments_pulled',2,'tx_hash','TX','block_height',20,'sealed_at','2026-07-30T00:00:00Z')
))::text, '0', 'a pack whose tx already belongs to a DIFFERENT pack (P4) is dropped');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.pack_rips WHERE pack_nft_id='P9'),
  'P9 never lands — the cross-batch NOT EXISTS guard held');

SELECT '✓ upsert_pack_rips_from_api invariants pass' AS result;
ROLLBACK;
