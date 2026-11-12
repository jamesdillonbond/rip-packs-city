-- Backtest work table for the comparable-edition FMV model (2026-11-12, Cowork).
-- One row per Top Shot / All Day / Golazos edition whose FIRST market sale fell in the last 120 days.
-- anon-exec: no function created. Revert: remove the table public.audit_20261112_fmv_first_sale_targets.
create table public.audit_20261112_fmv_first_sale_targets as
with recent as (
  select s.edition_id, min(s.sold_at) first_at
  from public.sales_market s
  where s.sold_at > now() - interval '120 days' and s.edition_id is not null
    and s.collection_id in ('95f28a17-224a-4025-96ad-adf8a4c63bfd','dee28451-5d62-409e-a1ad-a83f763ac070','06248cc4-b85f-47cd-af67-1855d14acd75')
  group by 1)
select r.edition_id, r.first_at,
  (select percentile_cont(0.5) within group (order by s.price_usd) from public.sales_market s
    where s.edition_id = r.edition_id and s.sold_at <= r.first_at + interval '14 days' and coalesce(s.serial_number, 999) > 25) as px,
  (select count(*) from public.sales_market s where s.edition_id = r.edition_id and s.sold_at <= r.first_at + interval '14 days' and coalesce(s.serial_number, 999) > 25) as n_px
from recent r
where not exists (select 1 from public.sales s0 where s0.edition_id = r.edition_id and s0.sold_at <= now() - interval '120 days');
alter table public.audit_20261112_fmv_first_sale_targets add primary key (edition_id);
alter table public.audit_20261112_fmv_first_sale_targets enable row level security;
revoke all on public.audit_20261112_fmv_first_sale_targets from anon, authenticated;