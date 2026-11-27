-- PENDING (not applied): apply_migration asked to confirm the DROP of the empty import table and the
-- question timed out unanswered 11-27 ~12:40 PM PT. Apply with apply_migration once confirmed; then move
-- this file into supabase/migrations/ under the version it is assigned.
--
-- audit_20261127_topshot_pack_pull_import_keyed_by_pack
--
-- 2026-11-27 (PT, afternoon; Claude Code cloud; Trevor: "Keep going and figure this out").
--
-- WHY: 20261127203636 keyed the retired-spork import by the OPEN transaction's deposits. A better
-- source turned up minutes later: Top Shot's PackNFT contract emits
--   Revealed(id: UInt64, salt: [UInt8], nfts: String)
-- whose `nfts` is the pack's full contents ("A.0b2a3299cc857e29.TopShot.53186932,..." -- verified on a
-- live event 11-27; a box lists "A.0b2a3299cc857e29.PackNFT.<id>"). One Dune row per pack (packs that
-- left a saved wallet, joined to their Revealed event) needs no 18,564-hash IN list and buys far fewer
-- datapoints. The table was empty (0 rows), so it is rebuilt keyed by (pack_nft_id, item_id).
--
-- WHAT: topshot_pack_pull_import(pack_nft_id, item_kind 'moment'|'pack', item_id, reveal_tx,
-- reveal_block, set/play/subedition/serial for a moment, source). load_topshot_pack_pull_import():
-- moments -> pack_open_pulls NAMED at load (editions.external_id set:play, or set:play::sub when the
-- subedition > 0); packs -> pack_box_contents. The opener comes from pack_rips (by pack id); with no rip
-- the row waits as 'no_rip' (retried on the next load, so a later rip is picked up).
-- topshot_retired_spork_open_txs() is dropped (its exclusion keyed on the old tx column).
--
-- WRITES: drops + recreates the empty import table; pack_open_pulls, pack_box_contents (additive).
-- REVERT: DELETE FROM public.pack_open_pulls WHERE resolved_via LIKE 'import:%';
--   DROP FUNCTION public.load_topshot_pack_pull_import(); DROP TABLE public.topshot_pack_pull_import;
--   (pack_box_contents rows from a load are not separately marked -- find them via the import's
--   item_kind = 'pack' rows).

DO $chk$
BEGIN
  IF (SELECT count(*) FROM public.topshot_pack_pull_import) > 0 THEN
    RAISE EXCEPTION 'topshot_pack_pull_import is not empty -- refusing to drop it';
  END IF;
END
$chk$;

DROP FUNCTION IF EXISTS public.load_topshot_pack_pull_import();
DROP FUNCTION IF EXISTS public.topshot_retired_spork_open_txs(integer, integer);
DROP TABLE IF EXISTS public.topshot_pack_pull_import;

CREATE TABLE public.topshot_pack_pull_import (
  pack_nft_id    text     NOT NULL CHECK (pack_nft_id ~ '^[0-9]{1,24}$'),
  item_kind      text     NOT NULL CHECK (item_kind IN ('moment', 'pack')),
  item_id        text     NOT NULL CHECK (item_id ~ '^[0-9]{1,24}$'),
  reveal_tx      text,
  reveal_block   bigint,
  set_id         integer,
  play_id        integer,
  subedition_id  integer,
  serial_number  integer,
  source         text     NOT NULL,
  imported_at    timestamptz NOT NULL DEFAULT now(),
  loaded_at      timestamptz,
  load_outcome   text,
  PRIMARY KEY (pack_nft_id, item_kind, item_id)
);
COMMENT ON TABLE public.topshot_pack_pull_import IS
  'Top Shot pack contents from PackNFT.Revealed for opens no live Flow node serves (pre-2025-10-14), with each moment''s mint (set/play/subedition/serial). Written by a Dune or indexer read; turned into pack_open_pulls / pack_box_contents by load_topshot_pack_pull_import() (audit_20261127_topshot_pack_pull_import_keyed_by_pack).';
ALTER TABLE public.topshot_pack_pull_import ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_pack_pull_import FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.topshot_pack_pull_import TO service_role;

CREATE OR REPLACE FUNCTION public.load_topshot_pack_pull_import()
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
  SELECT i.pack_nft_id, i.item_kind, i.item_id, i.set_id, i.play_id, i.subedition_id, i.source,
         r.opener_address
    FROM public.topshot_pack_pull_import i
    LEFT JOIN LATERAL (SELECT r0.opener_address FROM public.pack_rips r0
                        WHERE r0.collection_id = v_ts AND r0.pack_nft_id = i.pack_nft_id
                          AND r0.opener_address ~ '^0x[0-9a-f]{16}$'
                        LIMIT 1) r ON true
   WHERE i.loaded_at IS NULL OR i.load_outcome = 'no_rip';

  WITH ins AS (
    INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address, edition_id, resolved_via, resolved_at)
    SELECT v_ts, p.pack_nft_id, p.item_id, p.opener_address, ed.id,
           'import:' || p.source, CASE WHEN ed.id IS NOT NULL THEN now() END
      FROM _imp p
      LEFT JOIN LATERAL (
        SELECT e.id FROM public.editions e
         WHERE e.collection_id = v_ts
           AND e.external_id = p.set_id || ':' || p.play_id
                               || CASE WHEN COALESCE(p.subedition_id, 0) > 0 THEN '::' || p.subedition_id ELSE '' END
         LIMIT 1) ed ON p.set_id IS NOT NULL AND p.play_id IS NOT NULL
     WHERE p.item_kind = 'moment' AND p.opener_address IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING edition_id
  )
  SELECT count(*), count(edition_id) INTO v_pulls, v_named FROM ins;

  WITH ins AS (
    INSERT INTO public.pack_box_contents (collection_id, box_pack_nft_id, pack_nft_id, opener_address)
    SELECT v_ts, p.pack_nft_id, p.item_id, p.opener_address
      FROM _imp p
     WHERE p.item_kind = 'pack' AND p.opener_address IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inner FROM ins;

  UPDATE public.topshot_pack_pull_import i
     SET loaded_at = now(),
         load_outcome = CASE WHEN p.opener_address IS NULL THEN 'no_rip' ELSE 'loaded' END
    FROM _imp p
   WHERE i.pack_nft_id = p.pack_nft_id AND i.item_kind = p.item_kind AND i.item_id = p.item_id;

  SELECT count(*) INTO v_no_rip FROM _imp WHERE opener_address IS NULL;

  -- packs whose pulls just landed are repriced by collect_wallet_pack_pulls step (4)
  UPDATE public.pack_open_pull_values v SET priced_at = '-infinity'
    FROM (SELECT DISTINCT pack_nft_id FROM _imp WHERE item_kind = 'moment' AND opener_address IS NOT NULL) u
   WHERE v.collection_id = v_ts AND v.pack_nft_id = u.pack_nft_id;

  RETURN jsonb_build_object('pulls_written', v_pulls, 'named_at_load', v_named,
                            'inner_packs_written', v_inner, 'waiting_no_rip', v_no_rip);
END
$fn$;
REVOKE ALL ON FUNCTION public.load_topshot_pack_pull_import() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_topshot_pack_pull_import() TO service_role;
