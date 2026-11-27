-- audit_20261127_pack_reveal_import
--
-- 2026-11-27 (PT, ~1 PM; Claude Code cloud; Trevor: "Keep going and address what you can").
--
-- WHY: packs saved wallets SOLD that were opened before 2025-10-14 (block < 130290659) have no pull rows
-- and no live Flow node serves those blocks (#181): 18,564 Top Shot + 3,375 All Day on 11-27. The PackNFT
-- contracts emit Revealed(id: UInt64, salt: [UInt8], nfts: String) whose `nfts` is the pack's full
-- contents ("A.0b2a3299cc857e29.TopShot.53186932,..."; a box lists "...PackNFT.<id>"; verified on a live
-- event 11-27). Dune has every Revealed event. This is the landing table + loader for that read,
-- keyed by (collection, pack) -- pack ids overlap between Top Shot and All Day (ranges measured 11-27).
-- Supersedes the tx-keyed topshot_pack_pull_import (20261127203636, never written; its drop is left for
-- a confirmed cleanup -- it is empty and nothing reads it).
--
-- WHAT: pack_reveal_import(collection_id, pack_nft_id, item_kind 'moment'|'pack', item_id, reveal_tx,
-- reveal_block, set/play/subedition/serial (Top Shot mint) or edition_key (All Day editionID), source).
-- load_pack_reveal_import(): moments -> pack_open_pulls, NAMED at load where the edition is known
-- (Top Shot external_id set:play or set:play::sub for subedition > 0; All Day external_id = editionID);
-- packs -> pack_box_contents. Opener from pack_rips; with no rip the row waits as 'no_rip' and is retried.
--
-- WRITES: new table; pack_open_pulls, pack_box_contents, pack_open_pull_values.priced_at (additive).
-- REVERT: DELETE FROM public.pack_open_pulls WHERE resolved_via LIKE 'reveal:%';
--   DROP FUNCTION public.load_pack_reveal_import(); DROP TABLE public.pack_reveal_import;

CREATE TABLE IF NOT EXISTS public.pack_reveal_import (
  collection_id  uuid     NOT NULL REFERENCES public.collections(id),
  pack_nft_id    text     NOT NULL CHECK (pack_nft_id ~ '^[0-9]{1,24}$'),
  item_kind      text     NOT NULL CHECK (item_kind IN ('moment', 'pack')),
  item_id        text     NOT NULL CHECK (item_id ~ '^[0-9]{1,24}$'),
  reveal_tx      text,
  reveal_block   bigint,
  set_id         integer,
  play_id        integer,
  subedition_id  integer,
  edition_key    text,
  serial_number  integer,
  source         text     NOT NULL,
  imported_at    timestamptz NOT NULL DEFAULT now(),
  loaded_at      timestamptz,
  load_outcome   text,
  PRIMARY KEY (collection_id, pack_nft_id, item_kind, item_id)
);
COMMENT ON TABLE public.pack_reveal_import IS
  'Pack contents from PackNFT.Revealed for opens no live Flow node serves (pre-2025-10-14), with the moment''s edition where the source has it. Written by a Dune or indexer read (docs/integrations/dune-topshot-pack-reveals.sql); turned into pack_open_pulls / pack_box_contents by load_pack_reveal_import() (audit_20261127_pack_reveal_import).';
ALTER TABLE public.pack_reveal_import ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_reveal_import FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.pack_reveal_import TO service_role;

CREATE OR REPLACE FUNCTION public.load_pack_reveal_import()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_pulls integer := 0; v_named integer := 0; v_inner integer := 0; v_no_rip integer := 0;
BEGIN
  CREATE TEMP TABLE _imp ON COMMIT DROP AS
  SELECT i.collection_id, i.pack_nft_id, i.item_kind, i.item_id, i.set_id, i.play_id, i.subedition_id,
         i.edition_key, i.source, r.opener_address
    FROM public.pack_reveal_import i
    LEFT JOIN LATERAL (SELECT r0.opener_address FROM public.pack_rips r0
                        WHERE r0.collection_id = i.collection_id AND r0.pack_nft_id = i.pack_nft_id
                          AND r0.opener_address ~ '^0x[0-9a-f]{16}$'
                        LIMIT 1) r ON true
   WHERE i.loaded_at IS NULL OR i.load_outcome = 'no_rip';

  WITH ins AS (
    INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via, resolved_at)
    SELECT p.collection_id, p.pack_nft_id, p.item_id, p.opener_address, ed.id,
           'reveal:' || p.source, CASE WHEN ed.id IS NOT NULL THEN now() END
      FROM _imp p
      LEFT JOIN LATERAL (
        SELECT e.id FROM public.editions e
         WHERE e.collection_id = p.collection_id
           AND e.external_id = CASE
                 WHEN p.collection_id = v_ts AND p.set_id IS NOT NULL AND p.play_id IS NOT NULL
                   THEN p.set_id || ':' || p.play_id
                        || CASE WHEN COALESCE(p.subedition_id, 0) > 0 THEN '::' || p.subedition_id ELSE '' END
                 ELSE p.edition_key END
         LIMIT 1) ed ON true
     WHERE p.item_kind = 'moment' AND p.opener_address IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING edition_id
  )
  SELECT count(*), count(edition_id) INTO v_pulls, v_named FROM ins;

  WITH ins AS (
    INSERT INTO public.pack_box_contents (collection_id, box_pack_nft_id, pack_nft_id, opener_address)
    SELECT p.collection_id, p.pack_nft_id, p.item_id, p.opener_address
      FROM _imp p
     WHERE p.item_kind = 'pack' AND p.opener_address IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inner FROM ins;

  UPDATE public.pack_reveal_import i
     SET loaded_at = now(),
         load_outcome = CASE WHEN p.opener_address IS NULL THEN 'no_rip' ELSE 'loaded' END
    FROM _imp p
   WHERE i.collection_id = p.collection_id AND i.pack_nft_id = p.pack_nft_id
     AND i.item_kind = p.item_kind AND i.item_id = p.item_id;

  SELECT count(*) INTO v_no_rip FROM _imp WHERE opener_address IS NULL;

  -- packs whose pulls just landed are repriced by collect_wallet_pack_pulls step (4)
  UPDATE public.pack_open_pull_values v SET priced_at = '-infinity'
    FROM (SELECT DISTINCT collection_id, pack_nft_id FROM _imp
           WHERE item_kind = 'moment' AND opener_address IS NOT NULL) u
   WHERE v.collection_id = u.collection_id AND v.pack_nft_id = u.pack_nft_id;

  RETURN jsonb_build_object('pulls_written', v_pulls, 'named_at_load', v_named,
                            'inner_packs_written', v_inner, 'waiting_no_rip', v_no_rip);
END
$fn$;
REVOKE ALL ON FUNCTION public.load_pack_reveal_import() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_pack_reveal_import() TO service_role;
