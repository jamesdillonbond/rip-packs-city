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
-- (supabase/migrations/20260926180000_audit_20260926_wallet_pack_pulls_rpc_names_what_a_pack_really_yielded.sql).
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
CREATE TABLE public.pack_open_pulls (collection_id uuid, pack_nft_id text, nft_id text, opener_address text);
CREATE TABLE public.wallet_reconstructed_rips (wallet text, collection_id uuid, burst_id text, nft_ids text[]);

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
           'serial_number', coalesce(mo.serial_number, wm.serial_number),
           'edition_id', e.id,
           'player_name', e.player_name,
           'set_name', e.set_name,
           'tier', e.tier::text,
           'circulation_count', e.circulation_count,
           'thumbnail_url', e.thumbnail_url,
           'current_fmv', f.fmv_usd,
           'confidence', f.confidence
         ) ORDER BY u.ord), '[]'::jsonb),
         count(*), count(e.id), count(f.fmv_usd)
    INTO v_pulls, v_total, v_identified, v_priced
  FROM unnest(v_ids) WITH ORDINALITY AS u(nft_id, ord)
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
  LEFT JOIN public.editions e ON e.id = coalesce(mo.edition_id, wm.edition_id)
  LEFT JOIN LATERAL (
    SELECT CASE WHEN s.fmv_usd > 0 THEN s.fmv_usd END AS fmv_usd,
           CASE WHEN s.fmv_usd > 0 THEN s.confidence::text END AS confidence
      FROM public.fmv_snapshots s
     WHERE e.id IS NOT NULL AND s.collection_id = v_coll AND s.edition_id = e.id
     ORDER BY s.computed_at DESC
     LIMIT 1
  ) f ON true;

  RETURN jsonb_build_object('source', v_source, 'pulls', v_pulls,
                            'pulls_total', v_total, 'pulls_identified', v_identified, 'pulls_priced', v_priced);
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

ROLLBACK;
