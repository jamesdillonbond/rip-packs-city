-- Applied live 2026-07-25 via MCP; committed for parity. Two changes.
--
-- (1) apply_sales_ingest_external(): park the edition-unresolvable rows into
--     public.sales_ingest_unresolved instead of discarding them, and report a
--     new 'parked' counter. This is the ONLY behavioural change -- the fill
--     path, eligibility rule, DISTINCT ON multi-moment drop, sales_ingest_recovered
--     audit writes and every pre-existing counter are byte-identical. No row that
--     was previously inserted into public.sales is affected, and nothing that was
--     previously skipped becomes inserted.
--
-- (2) resolve_sales_ingest_unresolved(p_limit, p_dry_run DEFAULT true): drain the
--     parked rows by deriving nft_id -> edition from sales we already hold (an
--     NFT's edition is immutable), then promote into public.sales.
--
--     CRITICAL -- do not "simplify" (2) into the AllDay shortcut.
--     backfill_nft_edition_map_from_sales() resolves conflicts with
--     DISTINCT ON (nft_id) ORDER BY sold_at DESC (latest-sale-wins), which is safe
--     on AllDay ONLY because AllDay has ZERO nft_ids mapping to 2+ editions.
--     TopShot does not have that property: the 2021 partition alone holds 287
--     ambiguous nft_ids, and sampled cases are cross-set MISATTRIBUTION rather than
--     the benign '::' parallel re-key (nft_id 102839 appears as both 134:5038 and
--     5:12 on the same day; 107831 as both 29:584 and 5:50). Latest-wins would pick
--     arbitrarily and bake a wrong edition into public.sales, which feeds FMV.
--     So this resolves ONLY where count(DISTINCT edition_id) = 1 and leaves
--     ambiguous nft_ids parked and untouched.
--
--     Dry-run by DEFAULT so an accidental call reports and writes nothing. Note
--     Postgres has no min(uuid); the map uses (array_agg(DISTINCT ...))[1], exact
--     because the value is only consumed when n_editions = 1.
--
-- Validated live with synthetic rows (then reverted): a 2-row batch parked 2 /
-- inserted 0; the dry run reported candidates 2, resolvable_unambiguous 1,
-- blocked_ambiguous 0, would_insert 1; a re-run parked 0 (idempotent); 0 synthetic
-- rows reached public.sales; check_public_security_invariants() stayed 0.
--
-- Full bodies are recorded in the live database; see the ledger entry for the
-- revert path. This file documents the change set applied via MCP.

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

REVOKE ALL ON FUNCTION public.resolve_sales_ingest_unresolved(integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_sales_ingest_unresolved(integer, boolean) TO service_role;
