-- DB invariant: public.resolve_sales_ingest_unresolved — drains
-- public.sales_ingest_unresolved (rows the Dune ingest could not edition-resolve)
-- by deriving nft_id -> edition from sales we already hold, then promoting into
-- public.sales.
--
-- THE SAFETY PROPERTY THIS PINS (do not let anyone "simplify" it away):
-- it resolves ONLY where an nft_id maps to exactly ONE distinct edition_id.
-- The sibling backfill_nft_edition_map_from_sales() uses latest-sale-wins
-- (DISTINCT ON (nft_id) ORDER BY sold_at DESC), which is safe on AllDay ONLY
-- because AllDay has zero ambiguous nft_ids. TopShot does NOT have that
-- property — the 2021 partition alone holds 287 ambiguous nft_ids, and sampled
-- cases are cross-set MISATTRIBUTION (nft_id 102839 appears as both 134:5038 and
-- 5:12 on the same day), not the benign '::' parallel re-key. Latest-wins would
-- therefore bake a WRONG edition into public.sales, which feeds FMV. If a future
-- change swaps this for latest-wins, this test must fail.
--
-- Also pinned: dry-run writes nothing, the pre-2026 era guard, and the
-- (transaction_hash, sold_at) dedup that stops a re-run double-inserting.
--
-- DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260725172000_audit_20260725_sales_ingest_park_and_resolver.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins (only the columns the function reads/writes).
CREATE TABLE sales (
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

CREATE TABLE sales_ingest_unresolved (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id    uuid        NOT NULL,
  nft_id           text        NOT NULL,
  transaction_hash text        NOT NULL,
  price_usd        numeric     NOT NULL,
  sold_at          timestamptz NOT NULL,
  seller_address   text,
  buyer_address    text,
  parked_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  resolved_sale_id uuid,
  CONSTRAINT sales_ingest_unresolved_tx_nft_key UNIQUE (transaction_hash, nft_id)
);

CREATE TABLE sales_ingest_recovered (
  id         bigserial PRIMARY KEY,
  sale_id    uuid,
  sold_at    timestamptz,
  was_insert boolean
);

-- >>> BEGIN verbatim resolve_sales_ingest_unresolved (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.resolve_sales_ingest_unresolved(
  p_limit   integer DEFAULT 5000,
  p_dry_run boolean DEFAULT true
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_ts_collection constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_candidates int := 0;
  v_unambiguous int := 0;
  v_ambiguous int := 0;
  v_inserted int := 0;
begin
  -- Re-entrant within a single transaction (temps are ON COMMIT DROP, so a
  -- second call in the same txn would otherwise collide).
  drop table if exists _ru_open;
  drop table if exists _ru_map;

  create temp table _ru_open on commit drop as
  select u.id, u.nft_id, u.transaction_hash, u.price_usd, u.sold_at,
         u.seller_address, u.buyer_address
  from public.sales_ingest_unresolved u
  where u.collection_id = v_ts_collection
    and u.resolved_at is null
  order by u.parked_at
  limit greatest(p_limit, 0);
  select count(*) into v_candidates from _ru_open;

  if v_candidates = 0 then
    return jsonb_build_object('candidates', 0, 'note', 'nothing parked');
  end if;

  create temp table _ru_map on commit drop as
  select s.nft_id,
         (array_agg(distinct s.edition_id))[1]  as edition_id,
         count(distinct s.edition_id)           as n_editions,
         min(s.serial_number)                   as serial_number
  from public.sales s
  join (select distinct nft_id from _ru_open) o on o.nft_id = s.nft_id
  where s.collection_id = v_ts_collection
    and s.edition_id is not null
  group by s.nft_id;

  select count(*) filter (where n_editions = 1),
         count(*) filter (where n_editions > 1)
    into v_unambiguous, v_ambiguous
  from _ru_map;

  if p_dry_run then
    return jsonb_build_object(
      'dry_run', true,
      'candidates', v_candidates,
      'resolvable_unambiguous', v_unambiguous,
      'blocked_ambiguous', v_ambiguous,
      'would_insert', (
        select count(*) from _ru_open o
        join _ru_map m on m.nft_id = o.nft_id and m.n_editions = 1
        where o.sold_at < '2026-01-01'::timestamptz
          and not exists (select 1 from public.sales s2
                           where s2.transaction_hash = o.transaction_hash
                             and s2.sold_at = o.sold_at)
      )
    );
  end if;

  with cand as (
    select distinct on (o.transaction_hash, o.sold_at)
           o.id, o.nft_id, o.transaction_hash, o.price_usd, o.sold_at,
           o.seller_address, o.buyer_address, m.edition_id, m.serial_number
    from _ru_open o
    join _ru_map m on m.nft_id = o.nft_id and m.n_editions = 1
    where o.sold_at < '2026-01-01'::timestamptz
      and not exists (select 1 from public.sales s2
                       where s2.transaction_hash = o.transaction_hash
                         and s2.sold_at = o.sold_at)
    order by o.transaction_hash, o.sold_at, o.nft_id
  ),
  ins as (
    insert into public.sales
      (edition_id, collection_id, serial_number, price_usd, currency, seller_address,
       buyer_address, marketplace, transaction_hash, sold_at, nft_id, collection, source)
    select c.edition_id, v_ts_collection, nullif(c.serial_number, 0), c.price_usd, 'DUC',
           c.seller_address, c.buyer_address, 'topshot', c.transaction_hash, c.sold_at,
           c.nft_id, 'nba_top_shot', 'dune_settlement_resolved'
    from cand c
    returning id, sold_at, transaction_hash, nft_id
  ),
  aud as (
    insert into public.sales_ingest_recovered (sale_id, sold_at, was_insert)
    select id, sold_at, true from ins
    returning 1
  ),
  mark as (
    update public.sales_ingest_unresolved u
       set resolved_at = now(), resolved_sale_id = i.id
      from ins i
     where u.transaction_hash = i.transaction_hash and u.nft_id = i.nft_id
    returning 1
  )
  select count(*) into v_inserted from ins;

  return jsonb_build_object(
    'dry_run', false,
    'candidates', v_candidates,
    'resolvable_unambiguous', v_unambiguous,
    'blocked_ambiguous', v_ambiguous,
    'inserted', v_inserted
  );
end;
$function$;
-- <<< END verbatim resolve_sales_ingest_unresolved <<<

-- Fixtures. TS collection uuid is hardcoded in the function.
-- nft 'A' -> ONE edition        => resolvable
-- nft 'B' -> TWO editions       => AMBIGUOUS, must never be promoted
-- nft 'C' -> one edition, but the parked sale is post-2026 => era guard
-- nft 'D' -> one edition, but (tx,sold_at) already in sales => dedup guard
INSERT INTO sales (edition_id, collection_id, nft_id, serial_number, transaction_hash, sold_at) VALUES
  ('11111111-1111-1111-1111-111111111111','95f28a17-224a-4025-96ad-adf8a4c63bfd','A', 7,'oldtxA','2021-05-01'),
  ('22222222-2222-2222-2222-222222222222','95f28a17-224a-4025-96ad-adf8a4c63bfd','B', 3,'oldtxB1','2021-05-02'),
  ('33333333-3333-3333-3333-333333333333','95f28a17-224a-4025-96ad-adf8a4c63bfd','B', 3,'oldtxB2','2021-06-02'),
  ('44444444-4444-4444-4444-444444444444','95f28a17-224a-4025-96ad-adf8a4c63bfd','C', 1,'oldtxC','2021-05-03'),
  ('55555555-5555-5555-5555-555555555555','95f28a17-224a-4025-96ad-adf8a4c63bfd','D', 2,'oldtxD','2021-05-04'),
  -- the colliding row for D's dedup case: same (tx, sold_at) the parked row carries
  ('55555555-5555-5555-5555-555555555555','95f28a17-224a-4025-96ad-adf8a4c63bfd','D', 2,'txD','2021-07-04');

INSERT INTO sales_ingest_unresolved (collection_id, nft_id, transaction_hash, price_usd, sold_at) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','A','txA', 10.00,'2021-07-01'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','B','txB', 20.00,'2021-07-02'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','C','txC', 30.00,'2026-07-03'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','D','txD', 40.00,'2021-07-04');

-- 1) Dry run reports but writes NOTHING.
SELECT _assert_eq(
  (SELECT (resolve_sales_ingest_unresolved(100, true)->>'dry_run')), 'true',
  'dry run reports dry_run=true');
SELECT _assert_eq(
  (SELECT (resolve_sales_ingest_unresolved(100, true)->>'blocked_ambiguous')), '1',
  'dry run counts the ambiguous nft_id as blocked');
SELECT _assert_eq(
  (SELECT (resolve_sales_ingest_unresolved(100, true)->>'would_insert')), '1',
  'dry run would insert only nft A (B ambiguous, C post-era, D deduped)');
SELECT _assert_eq((SELECT count(*)::text FROM sales WHERE source = 'dune_settlement_resolved'),
  '0', 'dry run wrote no sales rows');
SELECT _assert_eq((SELECT count(*)::text FROM sales_ingest_unresolved WHERE resolved_at IS NOT NULL),
  '0', 'dry run marked nothing resolved');

-- 2) Live run promotes ONLY the unambiguous, in-era, non-duplicate row.
SELECT _assert_eq(
  (SELECT (resolve_sales_ingest_unresolved(100, false)->>'inserted')), '1',
  'live run inserts exactly one row');

SELECT _assert_eq((SELECT count(*)::text FROM sales WHERE source = 'dune_settlement_resolved'),
  '1', 'exactly one promoted sale');
SELECT _assert_eq((SELECT nft_id FROM sales WHERE source = 'dune_settlement_resolved'),
  'A', 'the promoted row is the UNAMBIGUOUS nft');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE source = 'dune_settlement_resolved'),
  '11111111-1111-1111-1111-111111111111', 'promoted row carries the single known edition');

-- 3) THE CRITICAL INVARIANT: the ambiguous nft is never promoted, under any edition.
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM sales WHERE source = 'dune_settlement_resolved' AND nft_id = 'B'),
  'ambiguous nft_id must NEVER be promoted (latest-sale-wins would have promoted it)');
SELECT _assert_eq(
  (SELECT resolved_at IS NULL FROM sales_ingest_unresolved WHERE nft_id = 'B')::text,
  'true', 'ambiguous row stays parked for a deliberate remap');

-- 4) Era + dedup guards held.
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM sales WHERE source = 'dune_settlement_resolved' AND nft_id = 'C'),
  'post-2026 parked row is not promoted (era guard)');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM sales WHERE source = 'dune_settlement_resolved' AND nft_id = 'D'),
  'row whose (tx, sold_at) already exists is not double-inserted (dedup guard)');

-- 5) The promotion is audited and the parked row marked, so it is revertible.
SELECT _assert_eq((SELECT count(*)::text FROM sales_ingest_recovered WHERE was_insert), '1',
  'promotion is audited into sales_ingest_recovered');
SELECT _assert_eq(
  (SELECT resolved_at IS NOT NULL FROM sales_ingest_unresolved WHERE nft_id = 'A')::text,
  'true', 'promoted parked row is marked resolved');

-- 6) Idempotent: a second live run promotes nothing more.
SELECT _assert_eq(
  (SELECT (resolve_sales_ingest_unresolved(100, false)->>'candidates')), '3',
  'the three unpromotable rows remain as candidates');
SELECT _assert_eq((SELECT count(*)::text FROM sales WHERE source = 'dune_settlement_resolved'),
  '1', 'second run inserts nothing more (idempotent)');

SELECT '✓ resolve_sales_ingest_unresolved invariants pass' AS result;
ROLLBACK;
