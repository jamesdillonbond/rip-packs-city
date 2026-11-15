-- 2026-11-14 PT. The data-integrity coverage alert changes from "overall FMV coverage < 95 %" to
-- "editions with market activity but no FMV" (Trevor, Candy FMV coverage handoff 11-14).
-- Why: the 95 % target counts every catalogued edition, and 21,009 of Candy's 21,472 editions have
-- never traded (incl. ~10,000 one-of-one generative cards), so the alert fired permanently
-- (76.9 %) while measuring nothing actionable. The actionable defect is an edition that HAS a
-- recorded sale and still no FMV: 0 on 11-14 across all six active collections.
--
-- "Market activity" = at least one row in `sales` for the edition. An active ASK alone is not
-- activity here: a listing is never FMV (candy-listings-indexer honesty constraint), so counting
-- asks would make the alarm permanently non-zero once legacy Candy asks are ingested.
--
-- Cost: the probe touches ~760k buffers and takes ~19 s cold (measured 11-14), far over the
-- route's 8 s RPC budget, so it is PRECOMPUTED here by pg_cron and the route reads the latest
-- snapshot (and treats a stale one as unknown, never as zero).
--
-- No retention step: the table grows by one row per active collection per run (~8,800 a year),
-- which is negligible. A retention statement in the body raised Supabase's destructive-statement
-- prompt (twice unanswered, 11-14). Prune by hand if it ever matters.
--
-- The one-of-one generative sets are reported in their own columns so coverage can be read
-- with and without them; nothing here decides which figure is the target.
--
-- Revert: SELECT cron.unschedule('rpc-fmv-activity-gap'); then remove the two functions
--         (public.refresh_fmv_activity_gap(), public.get_fmv_activity_gap()) and the table
--         public.fmv_activity_gap.
create table if not exists public.fmv_activity_gap (
  measured_at timestamptz not null,
  slug text not null,
  editions integer not null,
  fmv_editions integer not null,
  sold_no_fmv integer not null,
  sold_no_fmv_sample uuid[] not null default '{}',
  generative_1of1_editions integer not null default 0,
  generative_1of1_fmv_editions integer not null default 0,
  primary key (measured_at, slug)
);
alter table public.fmv_activity_gap enable row level security;
revoke all on public.fmv_activity_gap from public, anon, authenticated;

create or replace function public.refresh_fmv_activity_gap()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_at timestamptz := now();
  v_n integer;
  -- One-of-one generative Candy sets (each card its own edition): The Bat Cowl Collection,
  -- 2022 All-Star Tricons, Palm Garden: Inklings — 10,036 editions on 11-14.
  v_generative uuid[] := array[
    'd5945db5-d3f6-5a68-80f7-dd13df0a52b1',
    'bb316f8a-9a5b-559d-a612-8c146b575672',
    'cd0b289f-5400-5714-8755-4e461f2728ef'
  ]::uuid[];
begin
  with eds as materialized (
    select e.id, c.slug, (e.set_id = any (v_generative)) as generative, fs.one is not null as has_fmv
      from public.editions e
      join public.collections c on c.id = e.collection_id and c.is_active
      left join lateral (select 1 as one from public.fmv_snapshots f where f.edition_id = e.id limit 1) fs on true
  ), sold_gap as (
    select n.id, n.slug
      from eds n
      cross join lateral (select 1 from public.sales s where s.edition_id = n.id limit 1) s
     where not n.has_fmv
  )
  insert into public.fmv_activity_gap
    (measured_at, slug, editions, fmv_editions, sold_no_fmv, sold_no_fmv_sample,
     generative_1of1_editions, generative_1of1_fmv_editions)
  select v_at, e.slug,
         count(*)::int,
         count(*) filter (where e.has_fmv)::int,
         coalesce((select count(*) from sold_gap g where g.slug = e.slug), 0)::int,
         coalesce((select array_agg(g.id) from (select id from sold_gap g where g.slug = e.slug limit 10) g), '{}'),
         count(*) filter (where e.generative)::int,
         count(*) filter (where e.generative and e.has_fmv)::int
    from eds e
   group by e.slug;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;
revoke all on function public.refresh_fmv_activity_gap() from public, anon, authenticated;
grant execute on function public.refresh_fmv_activity_gap() to service_role;

-- The latest snapshot, one row per collection, with its age. Empty = never measured.
create or replace function public.get_fmv_activity_gap()
returns table (measured_at timestamptz, slug text, editions integer, fmv_editions integer,
               sold_no_fmv integer, sold_no_fmv_sample uuid[],
               generative_1of1_editions integer, generative_1of1_fmv_editions integer)
language sql
stable
security definer
set search_path = public
as $$
  select g.measured_at, g.slug, g.editions, g.fmv_editions, g.sold_no_fmv, g.sold_no_fmv_sample,
         g.generative_1of1_editions, g.generative_1of1_fmv_editions
    from public.fmv_activity_gap g
   where g.measured_at = (select max(measured_at) from public.fmv_activity_gap)
$$;
revoke all on function public.get_fmv_activity_gap() from public, anon, authenticated;
grant execute on function public.get_fmv_activity_gap() to service_role;

-- 4x a day; 05:53 UTC lands ~48 min before the 06:41 UTC data-integrity read.
select cron.schedule('rpc-fmv-activity-gap', '53 5,11,17,23 * * *', 'SELECT public.refresh_fmv_activity_gap()');