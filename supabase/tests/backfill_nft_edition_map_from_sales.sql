-- DB invariant: public.backfill_nft_edition_map_from_sales — the free-lane
-- self-heal that maps an unmapped NFT to its edition by reading a prior sale that
-- already carries the edition (pg_cron jobid 215). Its correctness rests on four
-- things a regression could silently break:
--   (a) the DERIVABILITY gate — only NFTs whose edition is ACTUALLY recoverable
--       from `sales` (a sale with edition_id) are considered. Without it the LIMIT
--       was consumed by rows that can never map, and an arbitrary heap slice hid
--       the ones that could — the 2026-07-27 defect where jobid 215 ran "48/48
--       GREEN while structurally blind" (0 of 1,235 derivable rows drained).
--   (b) a DETERMINISTIC slice (`order by us.nft_id ... limit`) so a run can't
--       repeat the same subset forever.
--   (c) latest-sale-wins conflict resolution (`distinct on (nft_id) order by
--       sold_at desc`) — this is the CURRENT behavior; pinning it makes any change
--       to it a conscious one (CLAUDE.md: safe on AllDay [0 ambiguous nft_ids],
--       NOT for TopShot [287 ambiguous] — that's a caller-side guard, not here).
--   (d) `on conflict do nothing` + `nullif(serial,0)` — never overwrite an
--       existing mapping; a 0 serial stores NULL, not a fake serial #0.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260727180000_audit_20260727_nem_from_sales_limit_binds_on_derivable_rows.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal fixtures: only the columns the function touches.
CREATE TABLE public.editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL
);
CREATE TABLE public.unmapped_sales (
  nft_id text NOT NULL,
  collection_id uuid NOT NULL,
  resolved_at timestamptz
);
CREATE TABLE public.nft_edition_map (
  collection_id uuid NOT NULL,
  nft_id text NOT NULL,
  edition_external_id text,
  serial_number integer,
  UNIQUE (collection_id, nft_id)
);
CREATE TABLE public.sales (
  collection_id uuid NOT NULL,
  nft_id text NOT NULL,
  edition_id uuid,
  serial_number integer,
  sold_at timestamptz
);

-- Two collections to prove scoping.
-- COLL_A = the collection under test; COLL_B = a different collection.
-- editions
INSERT INTO public.editions (id, external_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'set:play:1'),  -- e1
  ('22222222-2222-2222-2222-222222222222', 'set:play:2'),  -- e2 (the "later" edition for the ambiguous nft)
  ('33333333-3333-3333-3333-333333333333', 'set:play:3');  -- e3 (COLL_B)

-- unmapped_sales: the queue of NFTs to resolve.
INSERT INTO public.unmapped_sales (nft_id, collection_id, resolved_at) VALUES
  ('nftDerivable',   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL),  -- has a derivable sale
  ('nftAmbiguous',   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL),  -- two sales, diff editions
  ('nftNoEdition',   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL),  -- sale exists but edition_id NULL
  ('nftNoSale',      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL),  -- no sale at all
  ('nftResolved',    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now()), -- already resolved → excluded
  ('nftOtherColl',   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NULL);  -- COLL_B

-- sales carrying the recoverable edition.
INSERT INTO public.sales (collection_id, nft_id, edition_id, serial_number, sold_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftDerivable', '11111111-1111-1111-1111-111111111111', 5, '2026-01-01'),
  -- ambiguous nft: e1 sold earlier, e2 sold LATER → latest-wins picks e2
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftAmbiguous', '11111111-1111-1111-1111-111111111111', 9, '2026-01-01'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftAmbiguous', '22222222-2222-2222-2222-222222222222', 0, '2026-06-01'),
  -- nftNoEdition: a sale with NULL edition_id → not derivable
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'nftNoEdition', NULL, 3, '2026-01-01'),
  -- COLL_B derivable sale
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'nftOtherColl', '33333333-3333-3333-3333-333333333333', 1, '2026-01-01');

-- >>> BEGIN verbatim backfill_nft_edition_map_from_sales (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.backfill_nft_edition_map_from_sales(p_collection_id uuid, p_limit integer DEFAULT 5000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_inserted integer := 0;
begin
  with unmapped_nfts as (
    select us.nft_id
    from public.unmapped_sales us
    where us.collection_id = p_collection_id
      and us.resolved_at is null
      and not exists (
        select 1 from public.nft_edition_map m
        where m.collection_id = p_collection_id and m.nft_id = us.nft_id
      )
      -- Only consider nfts whose edition is ACTUALLY recoverable from sales.
      -- Without this the LIMIT was consumed by rows that can never produce a
      -- mapping, and an arbitrary heap-order slice permanently hid the ones
      -- that could (measured: 0 of 1,235 visible).
      and exists (
        select 1 from public.sales s
        where s.collection_id = p_collection_id
          and s.nft_id = us.nft_id
          and s.edition_id is not null
      )
    group by us.nft_id
    -- Deterministic slice: without an ORDER BY, LIMIT returns a heap-dependent
    -- set, so a run could repeat the same subset indefinitely.
    order by us.nft_id
    limit p_limit
  ),
  src as (
    select distinct on (s.nft_id)
      s.nft_id,
      e.external_id as edition_external_id,
      s.serial_number
    from public.sales s
    join unmapped_nfts u on u.nft_id = s.nft_id
    join public.editions e on e.id = s.edition_id
    where s.collection_id = p_collection_id
      and s.edition_id is not null
    order by s.nft_id, s.sold_at desc nulls last
  ),
  ins as (
    insert into public.nft_edition_map (collection_id, nft_id, edition_external_id, serial_number)
    select p_collection_id, src.nft_id, src.edition_external_id, nullif(src.serial_number, 0)
    from src
    on conflict (collection_id, nft_id) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;
  return v_inserted;
end
$function$;
-- <<< END verbatim backfill_nft_edition_map_from_sales <<<

-- (1) A full pass over COLL_A maps ONLY the two derivable nfts (Derivable +
-- Ambiguous). NoEdition / NoSale (not derivable), Resolved (resolved_at), and
-- OtherColl (different collection) are all excluded → exactly 2 inserted.
SELECT _assert_eq(
  public.backfill_nft_edition_map_from_sales('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::text,
  '2', 'a full pass maps only the 2 derivable, unresolved, in-collection nfts');

-- (2) The derivable nft got the right edition + serial (nullif keeps a real serial).
SELECT _assert_eq(
  (SELECT edition_external_id FROM public.nft_edition_map WHERE nft_id='nftDerivable'),
  'set:play:1', 'derivable nft mapped to its sale edition');
SELECT _assert_eq(
  (SELECT serial_number::text FROM public.nft_edition_map WHERE nft_id='nftDerivable'),
  '5', 'derivable nft carries its serial');

-- (3) latest-sale-wins: the ambiguous nft resolves to the LATER sale's edition
-- (e2, sold 2026-06 > e1 2026-01), and that sale's serial 0 stores as NULL.
SELECT _assert_eq(
  (SELECT edition_external_id FROM public.nft_edition_map WHERE nft_id='nftAmbiguous'),
  'set:play:2', 'ambiguous nft resolves latest-sale-wins (documents current behavior)');
SELECT _assert_eq(
  (SELECT serial_number::text FROM public.nft_edition_map WHERE nft_id='nftAmbiguous'),
  NULL, 'nullif(serial,0) → a 0 serial stores NULL, not a fake #0');

-- (4) Non-derivable + out-of-scope nfts were never inserted.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.nft_edition_map
     WHERE nft_id IN ('nftNoEdition','nftNoSale','nftResolved','nftOtherColl')),
  '0', 'non-derivable / resolved / other-collection nfts are never mapped');

-- (5) Idempotent: a second pass inserts nothing (the `not exists` filter now
-- excludes the two rows we just mapped) — 0, never a re-insert / overwrite.
SELECT _assert_eq(
  public.backfill_nft_edition_map_from_sales('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::text,
  '0', 'second pass is a no-op — never re-maps an already-mapped nft');

-- (6) Deterministic LIMIT slice: with the two mappings cleared and p_limit=1, the
-- pass maps exactly ONE nft — the lowest nft_id (order by us.nft_id). 'nftAmbiguous'
-- < 'nftDerivable' lexically, so the ambiguous one is chosen deterministically.
DELETE FROM public.nft_edition_map WHERE collection_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT _assert_eq(
  public.backfill_nft_edition_map_from_sales('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1)::text,
  '1', 'p_limit=1 maps exactly one nft');
SELECT _assert_eq(
  (SELECT nft_id FROM public.nft_edition_map WHERE collection_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'nftAmbiguous', 'the deterministic slice picks the lowest nft_id first');

SELECT '✓ backfill_nft_edition_map_from_sales invariants pass' AS result;
ROLLBACK;
