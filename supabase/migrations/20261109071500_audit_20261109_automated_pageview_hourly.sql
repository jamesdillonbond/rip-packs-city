-- 2026-11-09 (weekend activity review, telemetry item): our OWN post-deploy and
-- hourly sweeps (Playwright, headless Chrome) wrote 21,943 of the weekend's 22,548
-- usage_events page-view rows (97 %, ~11k/day). Every human reader already filters
-- them out (v_human_usage_events, user_activity, admin_visitor_journeys). The
-- telemetry route now COUNTS those page views per hour here instead of storing a
-- row each — the sweep's volume stays measurable. Third-party automated traffic
-- (Lightpanda, crawlers, HTTP clients, a spoofed UA caught by webdriver/stack) is
-- still written as tagged rows: that is the forensics the 2026-09-29 tag exists for.
--
-- Revert: drop function public.bump_automated_pageview(text);
--         drop table public.automated_pageview_hourly;
--         and revert the route change (app/api/telemetry/route.ts).
create table if not exists public.automated_pageview_hourly (
  hour timestamptz not null,
  automated_by text not null,
  n bigint not null default 0,
  primary key (hour, automated_by)
);
alter table public.automated_pageview_hourly enable row level security;
revoke all on public.automated_pageview_hourly from anon, authenticated;

create or replace function public.bump_automated_pageview(p_by text)
returns void
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  insert into public.automated_pageview_hourly (hour, automated_by, n)
  values (date_trunc('hour', now()), left(coalesce(nullif(p_by, ''), 'unknown'), 40), 1)
  on conflict (hour, automated_by) do update set n = automated_pageview_hourly.n + 1;
$$;
revoke all on function public.bump_automated_pageview(text) from public, anon, authenticated;
grant execute on function public.bump_automated_pageview(text) to service_role;
comment on function public.bump_automated_pageview(text) is
  'Hourly count of our own automated page views (Playwright / headless Chrome), written by /api/telemetry instead of a usage_events row. 2026-11-09.';