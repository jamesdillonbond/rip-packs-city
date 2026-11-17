-- audit_20260727_nem_from_sales_limit_binds_on_derivable_rows
--
-- WHY: backfill_nft_edition_map_from_sales() has the SAME static-window defect
-- fixed earlier today in the AllDay resolver routes, one layer down in SQL.
--
-- Its inner CTE selected candidate nft_ids with:
--     ... where resolved_at is null and not exists (map row) LIMIT p_limit
-- i.e. LIMIT 5000 with NO ORDER BY and NO requirement that the row actually BE
-- derivable. AllDay has 28,640 open unmapped nft_ids and only 1,235 of them have
-- an edition recoverable from public.sales. Postgres returns an arbitrary
-- scan-order slice of 5,000, and because the heap is essentially static the SAME
-- slice comes back every run.
--
-- MEASURED 2026-07-27 by replaying the CTE verbatim:
--     derivable_total 1235 | visible_to_job215 0 | invisible_to_job215 1235
-- So pg_cron jobid 215 (rpc-allday-nem-from-sales-backfill, */30) had run 48/48
-- SUCCEEDED in 24h while being structurally incapable of seeing a single row it
-- exists to drain. A healthy-looking, fully-green, zero-output pipeline.
--
-- FIX: push the derivability test INTO the candidate CTE so p_limit binds on the
-- useful population (1,235) instead of the whole backlog (28,640), plus a
-- deterministic ORDER BY so the slice is reproducible rather than heap-dependent.
--
-- Resolution logic is UNCHANGED: same `distinct on (s.nft_id) ... order by
-- s.sold_at desc` latest-sale-wins pick, same insert, same on-conflict. Only the
-- candidate SELECTION changes.
--
-- RESULT on ship: 1,235 mappings inserted (was 0/run), then
-- promote_unmapped_sales drained 568 real historical AllDay sales
-- (+243 already-in-sales dedups, 52 tx_hash collisions), at ZERO Flow REST cost.
-- For contrast, the on-chain borrow path measured 0/80 on the same backlog.
--
-- SAFETY (the CLAUDE.md warning on this function is TOPSHOT-specific — 287
-- ambiguous nft_ids there make latest-wins a misattribution risk). Re-verified
-- live for AllDay immediately before shipping:
--     derivable_nfts 1235 | unambiguous 1235 | ambiguous 0
-- Zero rows where sales disagree about the edition, so latest-wins cannot
-- misattribute here. The function stays collection-parameterised and this change
-- does NOT make it safe for TopShot — that caveat still stands.
--
-- REVERT: restore the prior body by dropping the added EXISTS predicate, the
-- GROUP BY and the ORDER BY from the unmapped_nfts CTE:
--   with unmapped_nfts as (
--     select distinct us.nft_id from public.unmapped_sales us
--     where us.collection_id = p_collection_id and us.resolved_at is null
--       and not exists (select 1 from public.nft_edition_map m
--                       where m.collection_id = p_collection_id and m.nft_id = us.nft_id)
--     limit p_limit
--   ), ... (remainder unchanged)

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
