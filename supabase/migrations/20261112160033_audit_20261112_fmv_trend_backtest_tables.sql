-- Work tables for the 2026-11-12 trend-signal backtest (Cowork). Read-only analysis inputs; nothing reads them in production.
-- anon-exec: no function created. Revert: remove the two audit_20261112_fmv_trend_* tables.
create table public.audit_20261112_fmv_trend_weekly as
select s.collection_id, s.edition_id, floor(extract(epoch from (timestamptz '2026-11-12 16:00+00' - s.sold_at)) / 604800)::int wk,
       percentile_cont(0.5) within group (order by s.price_usd) med, count(*)::int n, max(s.sold_at) last_at
from public.sales_market s
where s.sold_at > timestamptz '2026-11-12 16:00+00' - interval '91 days' and s.sold_at <= timestamptz '2026-11-12 16:00+00'
  and s.collection_id in ('95f28a17-224a-4025-96ad-adf8a4c63bfd','dee28451-5d62-409e-a1ad-a83f763ac070')
  and coalesce(s.serial_number, 999) > 25 and s.price_usd > 0
group by 1, 2, 3;
alter table public.audit_20261112_fmv_trend_weekly add primary key (edition_id, wk);
alter table public.audit_20261112_fmv_trend_weekly enable row level security;
revoke all on public.audit_20261112_fmv_trend_weekly from anon, authenticated;

create table public.audit_20261112_fmv_trend_targets as
select s.id sale_id, s.collection_id, s.edition_id, s.price_usd px, s.sold_at, p.fmv_usd pub, p.confidence::text conf, p.algo_version
from public.sales_market s
cross join lateral (select f.fmv_usd, f.confidence, f.algo_version from public.fmv_snapshots f
   where f.edition_id = s.edition_id and f.collection_id = s.collection_id
     and f.computed_at < s.sold_at - interval '1 day' and f.computed_at > s.sold_at - interval '60 days'
   order by f.computed_at desc limit 1) p
where s.sold_at > timestamptz '2026-11-12 16:00+00' - interval '7 days' and s.sold_at <= timestamptz '2026-11-12 16:00+00'
  and s.collection_id in ('95f28a17-224a-4025-96ad-adf8a4c63bfd','dee28451-5d62-409e-a1ad-a83f763ac070')
  and coalesce(s.serial_number, 999) > 25 and s.price_usd > 0 and p.fmv_usd > 0;
alter table public.audit_20261112_fmv_trend_targets enable row level security;
revoke all on public.audit_20261112_fmv_trend_targets from anon, authenticated;