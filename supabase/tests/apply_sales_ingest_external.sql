-- DB invariant: public.apply_sales_ingest_external — the Dune historical-settlement
-- sales ingest (Top Shot). It validates a jsonb batch, resolves each row to an
-- edition via public.moments, and then: (a) INSERTS genuinely-new resolved sales
-- (deduped to one per (tx_hash, sold_at) — the multi-moment guard), (b) FILLS a
-- missing counterparty on an already-recorded sale, (c) PARKS rows it cannot
-- resolve into sales_ingest_unresolved (so an already-paid-for Dune datapoint is
-- never re-bought), and audits every write. It writes the `sales` table (an FMV
-- input), so its validation gates are load-bearing: a 64-hex tx_hash, a positive
-- numeric price, a 16-hex 0x counterparty, and a sold_at strictly before the
-- 2026-01-01 historical cutoff. Returns a counts object.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260725172000_audit_20260725_sales_ingest_park_and_resolver.sql).
-- Its comment-stripped body was verified byte-identical to live prod via
-- pg_get_functiondef on 2026-07-31 (only inline comments differ, which the
-- staleness checker tolerates). __tests__/db-invariants-drift-guard.test.ts fails
-- CI if this copy drifts from the migration.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.moments (
  nft_id        text,
  collection_id uuid,
  edition_id    uuid,
  serial_number integer
);
CREATE TABLE public.sales (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id       uuid,
  collection_id    uuid,
  serial_number    integer,
  price_usd        numeric,
  currency         text,
  seller_address   text,
  buyer_address    text,
  marketplace      text,
  transaction_hash text,
  sold_at          timestamptz,
  nft_id           text,
  collection       text,
  source           text
);
CREATE TABLE public.sales_ingest_recovered (
  sale_id       uuid,
  sold_at       timestamptz,
  was_insert    boolean,
  filled_seller text,
  filled_buyer  text
);
CREATE TABLE public.sales_ingest_unresolved (
  collection_id    uuid,
  nft_id           text,
  transaction_hash text,
  price_usd        numeric,
  sold_at          timestamptz,
  seller_address   text,
  buyer_address    text,
  UNIQUE (transaction_hash, nft_id)
);

CREATE OR REPLACE FUNCTION public.apply_sales_ingest_external(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
declare
  v_ts_collection constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_n int := 0;
  v_inserted int := 0;
  v_filled int := 0;
  v_eligible int := 0;
  v_skipped_unresolved int := 0;
  v_skipped_existing int := 0;
  v_parked int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('error', 'p_rows must be a json array');
  end if;
  select count(*) into v_n from jsonb_array_elements(p_rows);
  if v_n = 0 then return jsonb_build_object('inserted', 0, 'filled', 0, 'note', 'empty batch'); end if;

  create temp table _si_inp on commit drop as
  select e->>'tx_hash'                              as tx_hash,
         e->>'nft_id'                               as nft_id,
         case when lower(e->>'seller') ~ '^0x[0-9a-f]{16}$' then lower(e->>'seller') end as seller,
         case when lower(e->>'buyer')  ~ '^0x[0-9a-f]{16}$' then lower(e->>'buyer')  end as buyer,
         (e->>'price_usd')::numeric                 as price_usd,
         (e->>'sold_at')::timestamptz               as sold_at
  from jsonb_array_elements(p_rows) e
  where e->>'tx_hash' ~ '^[0-9a-f]{64}$'
    and e->>'nft_id' is not null
    and (e->>'price_usd') ~ '^[0-9]+(\.[0-9]+)?$'
    and (e->>'price_usd')::numeric > 0
    and (e->>'sold_at') is not null
    and (e->>'sold_at')::timestamptz < '2026-01-01'::timestamptz;

  create temp table _si_res on commit drop as
  select i.tx_hash, i.nft_id, i.seller, i.buyer, i.price_usd, i.sold_at,
         m.edition_id, m.serial_number,
         exists (select 1 from public.sales s
                  where s.transaction_hash = i.tx_hash and s.nft_id = i.nft_id) as already
  from _si_inp i
  left join public.moments m
         on m.nft_id = i.nft_id and m.collection_id = v_ts_collection;

  with tofill as (
    select r.tx_hash, r.nft_id, r.seller, r.buyer
    from _si_res r
    where r.already and (r.seller is not null or r.buyer is not null)
  ),
  upd as (
    update public.sales s
       set seller_address = coalesce(s.seller_address, f.seller),
           buyer_address  = coalesce(s.buyer_address,  f.buyer)
      from tofill f
     where s.transaction_hash = f.tx_hash and s.nft_id = f.nft_id
       and ((s.seller_address is null and f.seller is not null)
         or (s.buyer_address  is null and f.buyer  is not null))
    returning s.id, s.sold_at,
              case when f.seller is not null then f.seller end as fs,
              case when f.buyer  is not null then f.buyer  end as fb
  ),
  aud as (
    insert into public.sales_ingest_recovered (sale_id, sold_at, was_insert, filled_seller, filled_buyer)
    select id, sold_at, false, fs, fb from upd
    returning 1
  )
  select count(*) into v_filled from upd;

  create temp table _si_cand on commit drop as
  select r.tx_hash, r.nft_id, r.seller, r.buyer, r.price_usd, r.sold_at,
         r.edition_id, r.serial_number
  from _si_res r
  where not r.already
    and r.edition_id is not null
    and not exists (select 1 from public.sales s2
                     where s2.transaction_hash = r.tx_hash and s2.sold_at = r.sold_at);
  select count(*) into v_eligible from _si_cand;

  with cand as (
    select distinct on (c.tx_hash, c.sold_at)
           c.edition_id, c.serial_number, c.price_usd, c.seller, c.buyer,
           c.tx_hash, c.sold_at, c.nft_id
    from _si_cand c
    order by c.tx_hash, c.sold_at, c.nft_id
  ),
  ins as (
    insert into public.sales
      (edition_id, collection_id, serial_number, price_usd, currency, seller_address,
       buyer_address, marketplace, transaction_hash, sold_at, nft_id, collection, source)
    select c.edition_id, v_ts_collection, c.serial_number, c.price_usd, 'DUC', c.seller,
           c.buyer, 'topshot', c.tx_hash, c.sold_at, c.nft_id, 'nba_top_shot', 'dune_settlement_ingest'
    from cand c
    returning id, sold_at
  ),
  aud as (
    insert into public.sales_ingest_recovered (sale_id, sold_at, was_insert)
    select id, sold_at, true from ins
    returning 1
  )
  select count(*) into v_inserted from ins;

  select count(*) into v_skipped_unresolved from _si_res where not already and edition_id is null;
  select count(*) into v_skipped_existing    from _si_res where already;

  -- NEW: park instead of discard.
  with parkable as (
    select distinct on (r.tx_hash, r.nft_id)
           r.tx_hash, r.nft_id, r.seller, r.buyer, r.price_usd, r.sold_at
    from _si_res r
    where not r.already and r.edition_id is null
    order by r.tx_hash, r.nft_id, r.sold_at
  ),
  parked as (
    insert into public.sales_ingest_unresolved
      (collection_id, nft_id, transaction_hash, price_usd, sold_at, seller_address, buyer_address)
    select v_ts_collection, p.nft_id, p.tx_hash, p.price_usd, p.sold_at, p.seller, p.buyer
    from parkable p
    on conflict (transaction_hash, nft_id) do nothing
    returning 1
  )
  select count(*) into v_parked from parked;

  return jsonb_build_object(
    'batch', v_n,
    'valid', (select count(*) from _si_res),
    'inserted', v_inserted,
    'filled', v_filled,
    'skipped_unresolved', v_skipped_unresolved,
    'skipped_existing', v_skipped_existing,
    'skipped_multimoment', v_eligible - v_inserted,
    'parked', v_parked
  );
end;
$function$;

\set ts '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set e1 '''e1111111-1111-1111-1111-111111111111'''
\set e2 '''e2222222-2222-2222-2222-222222222222'''

-- moments: n1->E1, nf1->E1, nf2->E2 resolve; nUNRESOLVED + n3 have no moment.
INSERT INTO public.moments (nft_id, collection_id, edition_id, serial_number) VALUES
  ('n1',  :ts::uuid, :e1::uuid, 5),
  ('nf1', :ts::uuid, :e1::uuid, 7),
  ('nf2', :ts::uuid, :e2::uuid, 9);

-- A pre-existing sale for the FILL case (tx_C + n3), with no counterparty yet.
INSERT INTO public.sales (transaction_hash, nft_id, sold_at, collection_id, price_usd)
VALUES (repeat('c',64), 'n3', '2025-05-01T00:00:00Z', :ts::uuid, 30);

CREATE TEMP TABLE _out AS SELECT public.apply_sales_ingest_external(jsonb_build_array(
  jsonb_build_object('tx_hash', repeat('a',64), 'nft_id','n1',          'price_usd','10','sold_at','2025-06-01T00:00:00Z','seller','0x'||repeat('a',16)),
  jsonb_build_object('tx_hash', repeat('b',64), 'nft_id','nUNRESOLVED', 'price_usd','20','sold_at','2025-06-01T00:00:00Z','seller','0x'||repeat('a',16)),
  jsonb_build_object('tx_hash', repeat('c',64), 'nft_id','n3',          'price_usd','30','sold_at','2025-05-01T00:00:00Z','seller','0x'||repeat('c',16)),
  jsonb_build_object('tx_hash', 'not-a-valid-hash',                     'nft_id','n4','price_usd','40','sold_at','2025-06-01T00:00:00Z'),
  jsonb_build_object('tx_hash', repeat('e',64), 'nft_id','n5',          'price_usd','50','sold_at','2026-06-01T00:00:00Z'),
  jsonb_build_object('tx_hash', repeat('f',64), 'nft_id','nf1',         'price_usd','60','sold_at','2025-07-01T00:00:00Z','seller','0x'||repeat('a',16)),
  jsonb_build_object('tx_hash', repeat('f',64), 'nft_id','nf2',         'price_usd','60','sold_at','2025-07-01T00:00:00Z','seller','0x'||repeat('a',16))
)) AS r;

-- ── The counts object ───────────────────────────────────────────────────────
SELECT _assert_eq((SELECT (r->>'batch')  FROM _out), '7', 'batch counts every input row (incl. the invalid ones)');
SELECT _assert_eq((SELECT (r->>'valid')  FROM _out), '5', 'valid drops the non-64-hex tx and the post-cutoff sold_at');
SELECT _assert_eq((SELECT (r->>'inserted') FROM _out), '2', 'inserts A (E1) and one of the F twins');
SELECT _assert_eq((SELECT (r->>'filled') FROM _out), '1', 'fills the missing seller on the pre-existing tx_C sale');
SELECT _assert_eq((SELECT (r->>'parked') FROM _out), '1', 'parks the unresolved nUNRESOLVED row');
SELECT _assert_eq((SELECT (r->>'skipped_unresolved') FROM _out), '1', 'one row had no edition');
SELECT _assert_eq((SELECT (r->>'skipped_existing') FROM _out), '1', 'one row already existed (tx_C)');
SELECT _assert_eq((SELECT (r->>'skipped_multimoment') FROM _out), '1', 'the second F twin (same tx+sold_at) is dropped by DISTINCT ON');

-- ── The inserted A sale carries the fixed ingest provenance ─────────────────
SELECT _assert_eq((SELECT source||'|'||currency||'|'||marketplace||'|'||collection||'|'||serial_number::text
  FROM public.sales WHERE transaction_hash=repeat('a',64)),
  'dune_settlement_ingest|DUC|topshot|nba_top_shot|5',
  'inserted rows are stamped as Dune settlement DUC/topshot/nba_top_shot with the moment serial');

-- ── The FILL wrote the seller onto the pre-existing sale (not a new row) ─────
SELECT _assert_eq((SELECT seller_address FROM public.sales WHERE transaction_hash=repeat('c',64)),
  '0x'||repeat('c',16), 'the missing counterparty was filled on the existing sale');
SELECT _assert_eq((SELECT count(*)::text FROM public.sales WHERE transaction_hash=repeat('c',64)), '1',
  'the fill did NOT insert a duplicate — the existing row was updated in place');

-- ── The unresolved row was parked, and only ONE F twin landed ───────────────
SELECT _assert_eq((SELECT count(*)::text FROM public.sales_ingest_unresolved WHERE nft_id='nUNRESOLVED'), '1',
  'the unresolvable Dune datapoint is parked, not discarded');
SELECT _assert_eq((SELECT count(*)::text FROM public.sales WHERE transaction_hash=repeat('f',64)), '1',
  'two moments in one settlement tx collapse to a single sales row (multi-moment guard)');

-- ── Provenance audit rows: 2 inserts + 1 fill ──────────────────────────────
SELECT _assert_eq((SELECT count(*)::text FROM public.sales_ingest_recovered WHERE was_insert), '2',
  'each insert is audited');
SELECT _assert_eq((SELECT count(*)::text FROM public.sales_ingest_recovered WHERE NOT was_insert), '1',
  'each counterparty fill is audited');

SELECT '✓ apply_sales_ingest_external invariants pass' AS result;
ROLLBACK;
