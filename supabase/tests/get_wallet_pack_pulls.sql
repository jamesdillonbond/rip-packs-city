-- DB invariant: public.get_wallet_pack_pulls — the pulls a wallet's pack row
-- shows when expanded. Added 2026-09-26: the old panel read
-- moment_acquisitions.source_pack_rip_id and listed 95 "pulls" for a 3-moment
-- pack. Claims it must keep:
--
--   1. Dapper's pull list for THIS pack AND THIS opener comes first
--      (source 'dapper_pulls'); another opener's list is never used.
--   2. Else the wallet's reconstructed rip (burst:<nft>) lists its own moments
--      (source 'delivery_burst') -- never another wallet's burst.
--   3. Else nothing: source NULL, pulls [] -- never a guess.
--   4. Editions and FMV are collection-scoped; latest snapshot wins; FMV 0 is
--      unpriced (current_fmv NULL), and the totals count exactly that.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260929163000_audit_20260929_pack_pull_serials_from_the_chain_read.sql).
--   5. (2026-09-29) A serial missing from moments and the cache comes from the
--      chain read -- for Top Shot only; never onto another collection's pull.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text UNIQUE, name text);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text, player_name text, set_name text,
  tier text, circulation_count int, thumbnail_url text);
CREATE TABLE public.moments (nft_id text, collection_id uuid, edition_id uuid, serial_number int);
CREATE TABLE public.wallet_moments_cache (wallet_address text, moment_id text, collection_id uuid, edition_key text, serial_number int);
CREATE TABLE public.fmv_snapshots (collection_id uuid, edition_id uuid, fmv_usd numeric, confidence text, computed_at timestamptz);
CREATE TABLE public.pack_open_pulls (collection_id uuid, pack_nft_id text, nft_id text, opener_address text,
  edition_id uuid, resolved_via text);
CREATE TABLE public.wallet_reconstructed_rips (wallet text, collection_id uuid, burst_id text, nft_ids text[]);
CREATE TABLE public.topshot_chain_moment_reads (nft_id bigint PRIMARY KEY, set_id int, play_id int, serial_number int,
  subedition_id int, owner_address text, block_height bigint, read_at timestamptz);

-- >>> BEGIN verbatim get_wallet_pack_pulls (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_wallet_pack_pulls(p_wallet text, p_collection_slug text, p_pack_nft_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '10s'
AS $function$
DECLARE
  v_wallet text := lower(trim(coalesce(p_wallet, '')));
  v_coll uuid;
  v_source text;
  v_ids text[];
  v_pulls jsonb;
  v_total int;
  v_identified int;
  v_priced int;
  v_inferred int;
BEGIN
  IF v_wallet = '' OR coalesce(p_pack_nft_id, '') = '' THEN
    RETURN jsonb_build_object('error', 'wallet and pack required');
  END IF;
  SELECT id INTO v_coll FROM public.collections
   WHERE slug = replace(coalesce(p_collection_slug, ''), '-', '_');
  IF v_coll IS NULL THEN
    RETURN jsonb_build_object('error', 'unknown collection');
  END IF;

  SELECT array_agg(o.nft_id ORDER BY o.nft_id) INTO v_ids
    FROM public.pack_open_pulls o
   WHERE o.collection_id = v_coll AND o.pack_nft_id = p_pack_nft_id AND o.opener_address = v_wallet;
  IF v_ids IS NOT NULL THEN
    v_source := 'dapper_pulls';
  ELSE
    SELECT r.nft_ids INTO v_ids
      FROM public.wallet_reconstructed_rips r
     WHERE r.wallet = v_wallet AND r.collection_id = v_coll AND r.burst_id = p_pack_nft_id;
    IF v_ids IS NOT NULL THEN
      v_source := 'delivery_burst';
    END IF;
  END IF;

  IF v_ids IS NULL THEN
    RETURN jsonb_build_object('source', NULL, 'pulls', '[]'::jsonb,
                              'pulls_total', NULL, 'pulls_identified', NULL, 'pulls_priced', NULL);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'nft_id', u.nft_id,
           -- 2026-09-29: else the serial read on chain at the rip block
           -- (Top Shot only; moments that left every wallet have no other)
           'serial_number', coalesce(mo.serial_number, wm.serial_number, cr.serial_number),
           'edition_id', e.id,
           'player_name', e.player_name,
           'set_name', e.set_name,
           'tier', e.tier::text,
           'circulation_count', e.circulation_count,
           'thumbnail_url', e.thumbnail_url,
           'current_fmv', f.fmv_usd,
           'confidence', f.confidence,
           -- 2026-09-29: how the pull was named -- 'record' (a row we hold about
           -- that moment id), 'id_neighbours' (inferred from the ids minted
           -- beside it; 99 % measured), NULL when unnamed
           'named_by', CASE WHEN e.id IS NULL THEN NULL
                            WHEN po.edition_id IS NOT NULL AND po.resolved_via = 'id_neighbours' THEN 'id_neighbours'
                            ELSE 'record' END
         ) ORDER BY u.ord), '[]'::jsonb),
         count(*), count(e.id), count(f.fmv_usd),
         count(*) FILTER (WHERE e.id IS NOT NULL AND po.resolved_via = 'id_neighbours')
    INTO v_pulls, v_total, v_identified, v_priced, v_inferred
  FROM unnest(v_ids) WITH ORDINALITY AS u(nft_id, ord)
  -- 2026-09-29: the pull lane's own name first (it also reads sales, the
  -- ownership walk, the edition map, Atlas and the id-neighbour inference), so
  -- this list names what the pack's VALUE was priced from -- before, a pull
  -- the lane had named from a sale showed as unknown here.
  LEFT JOIN LATERAL (
    SELECT o.edition_id, o.resolved_via FROM public.pack_open_pulls o
     WHERE v_source = 'dapper_pulls'
       AND o.collection_id = v_coll AND o.pack_nft_id = p_pack_nft_id
       AND o.opener_address = v_wallet AND o.nft_id = u.nft_id
       AND o.edition_id IS NOT NULL
     LIMIT 1
  ) po ON true
  LEFT JOIN LATERAL (
    SELECT m.edition_id, m.serial_number FROM public.moments m
     WHERE m.nft_id = u.nft_id AND m.collection_id = v_coll AND m.edition_id IS NOT NULL
     LIMIT 1
  ) mo ON true
  LEFT JOIN LATERAL (
    SELECT ed.id AS edition_id, w.serial_number FROM public.wallet_moments_cache w
      JOIN public.editions ed ON ed.collection_id = w.collection_id AND ed.external_id = w.edition_key
     WHERE w.moment_id = u.nft_id AND w.collection_id = v_coll AND w.edition_key IS NOT NULL
     LIMIT 1
  ) wm ON mo.edition_id IS NULL
  LEFT JOIN LATERAL (
    SELECT c.serial_number FROM public.topshot_chain_moment_reads c
     WHERE v_coll = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND u.nft_id ~ '^[0-9]{1,15}$' AND c.nft_id = u.nft_id::bigint
  ) cr ON mo.serial_number IS NULL AND wm.serial_number IS NULL
  LEFT JOIN public.editions e ON e.id = coalesce(po.edition_id, mo.edition_id, wm.edition_id)
  LEFT JOIN LATERAL (
    SELECT CASE WHEN s.fmv_usd > 0 THEN s.fmv_usd END AS fmv_usd,
           CASE WHEN s.fmv_usd > 0 THEN s.confidence::text END AS confidence
      FROM public.fmv_snapshots s
     WHERE e.id IS NOT NULL AND s.collection_id = v_coll AND s.edition_id = e.id
     ORDER BY s.computed_at DESC
     LIMIT 1
  ) f ON true;

  RETURN jsonb_build_object('source', v_source, 'pulls', v_pulls,
                            'pulls_total', v_total, 'pulls_identified', v_identified, 'pulls_priced', v_priced,
                            'pulls_inferred', v_inferred);
END;
$function$;
-- <<< END verbatim <<<

INSERT INTO public.collections VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', 'NBA Top Shot'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day', 'NFL All Day');
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000a1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1', 'Player One', 'Base Set', 'COMMON', 5000, 'https://t/1'),
  ('00000000-0000-0000-0000-0000000000a2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2', 'Player Two', 'Base Set', 'RARE', 99, 'https://t/2'),
  ('00000000-0000-0000-0000-0000000000b1', 'dee28451-5d62-409e-a1ad-a83f763ac070', '77', 'AD Player', 'AD Set', 'COMMON', 1, NULL);
INSERT INTO public.moments VALUES
  ('11', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a1', 101),
  ('13', 'dee28451-5d62-409e-a1ad-a83f763ac070', '00000000-0000-0000-0000-0000000000b1', 7);
INSERT INTO public.wallet_moments_cache VALUES ('0xz', '12', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2', 202);
INSERT INTO public.fmv_snapshots VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a1', 1, 'LOW', '2026-01-01'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a1', 3, 'HIGH', '2026-09-01'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a2', 0, 'LOW', '2026-09-01');
-- PK1 opened by 0xw: moments 11, 12, 13 (13 exists only as an All Day moment)
INSERT INTO public.pack_open_pulls VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK1', '11', '0xw'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK1', '12', '0xw'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK1', '13', '0xw'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK2', '11', '0xother');
INSERT INTO public.wallet_reconstructed_rips VALUES
  ('0xw', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'burst:12', ARRAY['12', '11']),
  ('0xother', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'burst:99', ARRAY['11']);

DO $$
DECLARE r jsonb;
BEGIN
  r := public.get_wallet_pack_pulls('0xW', 'nba-top-shot', 'PK1');
  PERFORM _assert_eq(r->>'source', 'dapper_pulls', 'Dapper list first; hyphen slug accepted; wallet case-folded');
  PERFORM _assert_eq(r->>'pulls_total', '3', 'exactly the pack''s three moments');
  PERFORM _assert_eq(r->>'pulls_identified', '2', '13 is an All Day moment id: never names a Top Shot pull');
  PERFORM _assert_eq(r->>'pulls_priced', '1', 'FMV 0 on edition a2 is unpriced');
  PERFORM _assert_eq(r->'pulls'->0->>'current_fmv', '3', 'latest snapshot (3), not the older 1');
  PERFORM _assert_eq(r->'pulls'->1->>'serial_number', '202', 'serial via wallet_moments_cache');
  PERFORM _assert(r->'pulls'->1->>'current_fmv' IS NULL, 'FMV 0 renders NULL, never $0');

  r := public.get_wallet_pack_pulls('0xw', 'nba_top_shot', 'PK2');
  PERFORM _assert(r->>'source' IS NULL AND jsonb_array_length(r->'pulls') = 0, 'another opener''s pull list is not this wallet''s');

  r := public.get_wallet_pack_pulls('0xw', 'nba_top_shot', 'burst:12');
  PERFORM _assert_eq(r->>'source', 'delivery_burst', 'a reconstructed rip lists its own moments');
  PERFORM _assert_eq(r->'pulls'->0->>'nft_id', '12', 'in delivery order');
  PERFORM _assert((public.get_wallet_pack_pulls('0xw', 'nba_top_shot', 'burst:99'))->>'source' IS NULL, 'never another wallet''s burst');

  PERFORM _assert((public.get_wallet_pack_pulls('0xw', 'nba_top_shot', 'NOPE'))->>'source' IS NULL, 'unknown pack -> nothing, not a guess');
  PERFORM _assert((public.get_wallet_pack_pulls('0xw', 'nope', 'PK1'))->>'error' = 'unknown collection', 'unknown collection refused');
  PERFORM _assert((public.get_wallet_pack_pulls('', 'nba_top_shot', 'PK1'))->>'error' IS NOT NULL, 'empty wallet refused');
END $$;

-- 2026-09-29: the lane's own names come first, and an inferred one says so.
-- PK3: 21 named by the lane from a sale (in neither moments nor the cache),
-- 22 named by id neighbours, 23 unnamed everywhere.
INSERT INTO public.pack_open_pulls VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK3', '21', '0xw', '00000000-0000-0000-0000-0000000000a1', 'sales'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK3', '22', '0xw', '00000000-0000-0000-0000-0000000000a1', 'id_neighbours'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK3', '23', '0xw', NULL, NULL);
DO $$
DECLARE r jsonb;
BEGIN
  r := public.get_wallet_pack_pulls('0xw', 'nba_top_shot', 'PK3');
  PERFORM _assert_eq(r->>'pulls_identified', '2', 'the lane''s names (a sale, an inference) are used -- before, both read unknown');
  PERFORM _assert_eq(r->'pulls'->0->>'named_by', 'record', '21 named from a record');
  PERFORM _assert_eq(r->'pulls'->1->>'named_by', 'id_neighbours', '22 says it is inferred');
  PERFORM _assert(r->'pulls'->2->>'named_by' IS NULL AND r->'pulls'->2->>'player_name' IS NULL, '23 unnamed stays unnamed');
  PERFORM _assert_eq(r->>'pulls_inferred', '1', 'one inferred name, counted');
  r := public.get_wallet_pack_pulls('0xW', 'nba-top-shot', 'PK1');
  PERFORM _assert(r->>'pulls_inferred' = '0' AND r->'pulls'->0->>'named_by' = 'record', 'PK1 unchanged: record names, none inferred');
END $$;

-- 2026-09-29: serials read on chain. 21 has none in moments or the cache; 11
-- has 101 in moments (the chain read, planted as 999, must not override it);
-- an All Day pack pulled an id (21) equal to a Top Shot chain read.
INSERT INTO public.topshot_chain_moment_reads VALUES
  (21, 1, 1, 459, 0, '0xw', 100, now()),
  (11, 1, 1, 999, 0, '0xw', 100, now());
INSERT INTO public.pack_open_pulls VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'AD1', '21', '0xw', NULL, NULL);
DO $$
DECLARE r jsonb;
BEGIN
  r := public.get_wallet_pack_pulls('0xw', 'nba_top_shot', 'PK3');
  PERFORM _assert_eq(r->'pulls'->0->>'serial_number', '459', 'a pull only the chain read has a serial for shows it');
  PERFORM _assert(r->'pulls'->2->>'serial_number' IS NULL, '23: no read anywhere, no serial');
  r := public.get_wallet_pack_pulls('0xW', 'nba-top-shot', 'PK1');
  PERFORM _assert_eq(r->'pulls'->0->>'serial_number', '101', 'moments'' serial wins over the chain read');
  r := public.get_wallet_pack_pulls('0xw', 'nfl_all_day', 'AD1');
  PERFORM _assert(r->'pulls'->0->>'serial_number' IS NULL, 'a Top Shot chain read never gives an All Day pull a serial');
END $$;

ROLLBACK;
