-- audit_20261127_topshot_pack_pull_import_for_retired_sporks
--
-- 2026-11-27 (PT, afternoon; Claude Code cloud; Trevor: "Keep going and figure this out. This is
-- essential").
--
-- WHY: 18,564 Top Shot packs saved wallets SOLD were opened before 2025-10-14 (Flow sporks mainnet26 and
-- older, block < 130290659) and have NO pull rows: their moments never reached moment_acquisitions, and
-- no Flow node serves those blocks any more (#181; the mainnet26 host no longer resolves, measured
-- 11-27). Probed and dead on 11-27: Atlas (Top Shot pulls read "0", NFT packNftId "0"), Top Shot
-- public GraphQL (HTTP 530), Find Labs historical API (503). Flowscan has the data but its API needs a
-- credential we do not hold. The source is Dune `flow.cadence_events` (TopShot.Deposit in the open tx
-- + MomentMinted for set/play/subedition/serial). Dune needs credits or an extra-credits limit.
--
-- WHAT: a landing table for those rows and a loader that turns them into pack_open_pulls, NAMED at
-- load (editions.external_id = set:play, or set:play::sub for a parallel; subedition 0 = Standard).
-- Source-agnostic: any reader of open-tx deposits (Dune, a paid Flow indexer) writes the same rows.
-- topshot_retired_spork_open_txs(p_from, p_n) lists the open tx hashes still needing a read, oldest
-- first, so a batch can be built for whichever source runs.
--
-- WRITES: new table topshot_pack_pull_import; pack_open_pulls (additive, ON CONFLICT DO NOTHING).
-- REVERT: DELETE FROM public.pack_open_pulls WHERE resolved_via LIKE 'import:%';
--   DROP FUNCTION public.load_topshot_pack_pull_import(); DROP FUNCTION public.topshot_retired_spork_open_txs(integer, integer);
--   DROP TABLE public.topshot_pack_pull_import.

CREATE TABLE IF NOT EXISTS public.topshot_pack_pull_import (
  tx_hash        text   NOT NULL CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  nft_id         text   NOT NULL CHECK (nft_id ~ '^[0-9]{1,15}$'),
  to_address     text   NOT NULL,
  set_id         integer,
  play_id        integer,
  subedition_id  integer,
  serial_number  integer,
  source         text   NOT NULL,
  imported_at    timestamptz NOT NULL DEFAULT now(),
  loaded_at      timestamptz,
  load_outcome   text,
  PRIMARY KEY (tx_hash, nft_id)
);
COMMENT ON TABLE public.topshot_pack_pull_import IS
  'TopShot.Deposit events of pack-open transactions no live Flow node serves (pre-2025-10-14), with the moment''s mint (set/play/subedition/serial). Written by a Dune or indexer read; turned into pack_open_pulls by load_topshot_pack_pull_import() (audit_20261127_topshot_pack_pull_import_for_retired_sporks).';
ALTER TABLE public.topshot_pack_pull_import ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_pack_pull_import FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.topshot_pack_pull_import TO service_role;

CREATE OR REPLACE FUNCTION public.topshot_retired_spork_open_txs(p_from integer DEFAULT 0, p_n integer DEFAULT 6500)
RETURNS TABLE (tx_hash text, block_height bigint, opened_on date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH RECURSIVE sold AS (
    SELECT h.pack_nft_id FROM public.topshot_pack_sales_history h
     WHERE h.purchased AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
    UNION
    SELECT pp.pack_nft_id FROM public.pack_purchases pp
     WHERE pp.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND pp.pack_nft_id IS NOT NULL
       AND pp.custom_id IS DISTINCT FROM 'nba'
       AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
  ), scope(pack_nft_id, depth) AS (
    SELECT pack_nft_id, 0 FROM sold
    UNION
    SELECT b.pack_nft_id, s.depth + 1 FROM scope s
      JOIN public.pack_box_contents b ON b.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND b.box_pack_nft_id = s.pack_nft_id
     WHERE s.depth < 2
  )
  SELECT r.tx_hash, r.block_height, (r.sealed_at AT TIME ZONE 'UTC')::date
    FROM (SELECT DISTINCT pack_nft_id FROM scope) s
    CROSS JOIN LATERAL (SELECT r0.* FROM public.pack_rips r0
                         WHERE r0.pack_nft_id = s.pack_nft_id AND r0.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
                         LIMIT 1) r
   WHERE r.block_height < 130290659
     AND r.tx_hash ~ '^[0-9a-f]{64}$'
     AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions ma
                      WHERE ma.source_pack_rip_id = r.id AND ma.acquisition_method = 'pack_pull')
     AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o
                      WHERE o.collection_id = r.collection_id AND o.pack_nft_id = r.pack_nft_id)
     AND NOT EXISTS (SELECT 1 FROM public.topshot_pack_pull_import i WHERE i.tx_hash = r.tx_hash)
   ORDER BY r.block_height
   OFFSET GREATEST(p_from, 0) LIMIT GREATEST(p_n, 0)
$fn$;
REVOKE ALL ON FUNCTION public.topshot_retired_spork_open_txs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_retired_spork_open_txs(integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.load_topshot_pack_pull_import()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_written integer := 0; v_named integer := 0; v_no_rip integer := 0; v_not_opener integer := 0;
BEGIN
  WITH pend AS (
    SELECT i.*, r.pack_nft_id, r.opener_address
      FROM public.topshot_pack_pull_import i
      LEFT JOIN LATERAL (SELECT r0.pack_nft_id, r0.opener_address FROM public.pack_rips r0
                          WHERE r0.collection_id = v_ts AND r0.tx_hash = i.tx_hash LIMIT 1) r ON true
     WHERE i.loaded_at IS NULL
  ), ins AS (
    INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via, resolved_at)
    SELECT v_ts, p.pack_nft_id, p.nft_id, p.opener_address, ed.id,
           'import:' || p.source, CASE WHEN ed.id IS NOT NULL THEN now() END
      FROM pend p
      LEFT JOIN LATERAL (
        SELECT e.id FROM public.editions e
         WHERE e.collection_id = v_ts
           AND e.external_id = p.set_id || ':' || p.play_id
                               || CASE WHEN COALESCE(p.subedition_id, 0) > 0 THEN '::' || p.subedition_id ELSE '' END
         LIMIT 1) ed ON p.set_id IS NOT NULL AND p.play_id IS NOT NULL
     WHERE p.pack_nft_id IS NOT NULL
       -- a pull is a deposit TO THE OPENER in the open tx (a tx can move other moments too)
       AND lower(CASE WHEN p.to_address ~* '^0x' THEN p.to_address ELSE '0x' || p.to_address END) = p.opener_address
    ON CONFLICT DO NOTHING
    RETURNING edition_id
  ), mark AS (
    UPDATE public.topshot_pack_pull_import i
       SET loaded_at = now(),
           load_outcome = CASE WHEN p.pack_nft_id IS NULL THEN 'no_rip_for_tx'
                               WHEN lower(CASE WHEN p.to_address ~* '^0x' THEN p.to_address ELSE '0x' || p.to_address END)
                                    <> p.opener_address THEN 'not_to_opener'
                               ELSE 'loaded' END
      FROM pend p
     WHERE i.tx_hash = p.tx_hash AND i.nft_id = p.nft_id
    RETURNING i.load_outcome
  )
  SELECT (SELECT count(*) FROM ins), (SELECT count(edition_id) FROM ins),
         (SELECT count(*) FILTER (WHERE load_outcome = 'no_rip_for_tx') FROM mark),
         (SELECT count(*) FILTER (WHERE load_outcome = 'not_to_opener') FROM mark)
    INTO v_written, v_named, v_no_rip, v_not_opener;
  RETURN jsonb_build_object('pulls_written', v_written, 'named_at_load', v_named,
                            'no_rip_for_tx', v_no_rip, 'not_to_opener', v_not_opener);
END
$fn$;
REVOKE ALL ON FUNCTION public.load_topshot_pack_pull_import() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_topshot_pack_pull_import() TO service_role;
