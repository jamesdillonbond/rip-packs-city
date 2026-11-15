-- 2026-11-14 ~6:45 PM PT. Candy FMV coverage (data-integrity "Overall FMV coverage 76.9%").
-- Cause: lib/candy/collections-market.ts walks each legacy collection's ME activity feed back to
-- sales_high_water_at, and a FIRST walk looked back only FIRST_WALK_LOOKBACK_MS = 30 days. Those
-- first walks ran 11-08/09, inside Candy's 10-12 -> 11-06 market lock, so every pre-lock sale ME
-- still serves (measured 11-14 from the Cowork container: 5,471 sales on 320 symbols, Aug-Nov 2026,
-- ~89% of them on editions with no FMV) was never offered to the drain.
-- Fix: rewind the cursor to 2026-07-01 so the deployed lane re-walks that history itself (<= 20
-- pages/collection, existing dedupe against `sales` and the queue, the candy-sales-indexer drain
-- stays the one writer). The lane only ever moves the cursor forward again.
-- Revert: UPDATE candy_collections c SET sales_high_water_at = b.sales_high_water_at
--         FROM audit_20261115_candy_high_water_backup b WHERE b.address = c.address;
create table public.audit_20261115_candy_high_water_backup as
select address, me_symbol, sales_high_water_at, now() as backed_up_at
  from public.candy_collections
 where registry_key is null and me_symbol is not null and kind <> 'test';
alter table public.audit_20261115_candy_high_water_backup enable row level security;
revoke all on public.audit_20261115_candy_high_water_backup from anon, authenticated;

update public.candy_collections
   set sales_high_water_at = timestamptz '2026-07-01 00:00:00+00'
 where registry_key is null and me_symbol is not null and kind <> 'test';

-- The fetch-plan table from the abandoned pg_net approach is no longer needed.
drop table if exists public.audit_20261115_candy_legacy_sales_pages;