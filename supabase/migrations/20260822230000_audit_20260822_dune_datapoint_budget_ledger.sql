-- audit_20260822_dune_datapoint_budget_ledger
--
-- WHY THIS EXISTS
-- ---------------
-- Dune bills two meters and the one that stops us is DATAPOINTS (~= rows
-- returned by the API), not credits. On 2026-07-24 the billing cycle reset and
-- both Dune lanes drained the entire cycle's datapoints by 06:11 the same
-- morning -- measured, not estimated, in docs/dune-budget-analysis-2026-07-26.md.
-- Every lane walks flat out until the API answers 402, so "spend it all in six
-- hours" is the DESIGNED behaviour, not an accident, and nothing anywhere counts
-- what has been spent. The credits gauge on dune.com reads comfortable while the
-- datapoint limit is exhausted, so there is currently no instrument at all.
--
-- This adds the two things missing: a LEDGER of what each lane bought, and a
-- BUDGET the routes ask before they buy. It changes no pipeline's data
-- behaviour -- an unbounded walk becomes a bounded one.
--
-- ⚠ WHAT IS MEASURED AND WHAT IS ESTIMATED. `rows_returned` is exact (the route
-- counts the rows it received). `datapoints_est` is rows x columns, which is
-- Dune's documented shape but not a figure we can read back from them, so it is
-- named `_est` and NOTHING enforces on it. The caps below are in ROWS, the unit
-- we measure exactly.
--
-- ⚠ THE CAP NUMBER IS A PACE, NOT THE PLAN'S LIMIT. Nobody here knows the real
-- per-cycle datapoint allowance -- the July burn only proves it is somewhere
-- above ~637k rows. `cycle_row_cap` is therefore NULL (unknown, and a guess
-- would be a fabricated number), and only `day_row_cap` binds: whatever the true
-- cap is, it can no longer be spent in one day. When the next 402 lands, the
-- ledger says exactly how many rows bought it -- set `cycle_row_cap` to that and
-- the pace term below turns real pacing on.

-- ── The ledger ────────────────────────────────────────────────────────────
create table if not exists public.dune_api_usage (
  id               bigint generated always as identity primary key,
  occurred_at      timestamptz not null default now(),
  pipeline         text        not null,
  endpoint         text        not null check (endpoint in ('execute', 'status', 'results')),
  query_id         text,
  -- ⚠ NULL, never 0, when nothing was measured (an /execute buys no rows). A 0
  -- here would be a measurement nobody took -- the `?? 0` shape this repo bans,
  -- in telemetry.
  rows_returned    integer,
  columns_returned integer,
  datapoints_est   integer,
  http_status      integer,
  note             text
);

create index if not exists idx_dune_api_usage_occurred_at
  on public.dune_api_usage (occurred_at desc);
create index if not exists idx_dune_api_usage_pipeline_occurred
  on public.dune_api_usage (pipeline, occurred_at desc);

alter table public.dune_api_usage enable row level security;
revoke all on table public.dune_api_usage from public, anon, authenticated;
grant select, insert on table public.dune_api_usage to service_role;

comment on table public.dune_api_usage is
  'Append-only ledger of every Dune API call made through workers/dune-proxy. '
  'rows_returned is exact; datapoints_est = rows x columns is an estimate and is '
  'never enforced on. Read by public.dune_budget_status().';

-- ── The budget ────────────────────────────────────────────────────────────
create table if not exists public.dune_budget_state (
  id               smallint primary key default 1 check (id = 1),
  -- Day of the UTC month the Dune billing cycle resets. 24 is derived from the
  -- 2026-07-24 reset observed in the July burn; re-derive it against the Dune
  -- billing page rather than trusting this default.
  cycle_anchor_day smallint    not null default 24 check (cycle_anchor_day between 1 and 28),
  -- The pace. 150,000 rows/UTC-day fits one full ownership walk (114,083 rows
  -- as of 2026-08-17) and refuses a second one the same day.
  day_row_cap      bigint      not null default 150000 check (day_row_cap >= 0),
  -- NULL = the plan's true cycle limit is unknown. Setting it enables pacing:
  -- (cycle_row_cap - spent) / days_left_in_cycle.
  cycle_row_cap    bigint      check (cycle_row_cap is null or cycle_row_cap >= 0),
  -- One-row kill switch: true stops every Dune lane at its next check, with no
  -- deploy and no cron edit.
  paused           boolean     not null default false,
  updated_at       timestamptz not null default now(),
  note             text
);

insert into public.dune_budget_state (id) values (1) on conflict (id) do nothing;

alter table public.dune_budget_state enable row level security;
revoke all on table public.dune_budget_state from public, anon, authenticated;
grant select on table public.dune_budget_state to service_role;

comment on table public.dune_budget_state is
  'Single-row Dune spend policy. UPDATE day_row_cap / cycle_row_cap / paused to '
  'change every lane at once with no deploy.';

-- ── What the routes ask before they buy ───────────────────────────────────
create or replace function public.dune_budget_status()
returns jsonb
language plpgsql
stable
as $$
declare
  st              public.dune_budget_state%rowtype;
  v_today         date;
  v_anchor_this   date;
  v_cycle_start_d date;
  v_cycle_end_d   date;
  v_cycle_start   timestamptz;
  v_rows_cycle    bigint;
  v_dp_cycle      bigint;
  v_rows_today    bigint;
  v_dp_today      bigint;
  v_days_left     integer;
  v_pace          bigint;
  v_allowed       bigint;
begin
  select * into st from public.dune_budget_state where id = 1;

  -- ⚠ A MISSING CONFIG ROW IS NOT "UNLIMITED". Fail closed: an unreadable or
  -- absent policy means we cannot prove there is budget, and the failure mode
  -- this function exists to prevent is spending a month in a morning.
  if not found then
    return jsonb_build_object(
      'configured', false,
      'paused', false,
      'rows_allowed_now', 0,
      'reason', 'no dune_budget_state row'
    );
  end if;

  v_today := (now() at time zone 'utc')::date;
  v_anchor_this := (date_trunc('month', v_today::timestamp))::date + (st.cycle_anchor_day - 1);
  if v_today >= v_anchor_this then
    v_cycle_start_d := v_anchor_this;
  else
    v_cycle_start_d := (date_trunc('month', v_today::timestamp) - interval '1 month')::date
                       + (st.cycle_anchor_day - 1);
  end if;
  v_cycle_end_d := (v_cycle_start_d + interval '1 month')::date;
  v_cycle_start := (v_cycle_start_d::timestamp) at time zone 'utc';

  -- sum() over zero ledger rows is a genuine "nothing spent yet", not an
  -- unmeasured value, so coalescing to 0 is honest here.
  select coalesce(sum(rows_returned), 0), coalesce(sum(datapoints_est), 0)
    into v_rows_cycle, v_dp_cycle
    from public.dune_api_usage
   where occurred_at >= v_cycle_start;

  select coalesce(sum(rows_returned), 0), coalesce(sum(datapoints_est), 0)
    into v_rows_today, v_dp_today
    from public.dune_api_usage
   where occurred_at >= (v_today::timestamp) at time zone 'utc';

  v_days_left := greatest(1, v_cycle_end_d - v_today);

  v_allowed := greatest(0, st.day_row_cap - v_rows_today);

  if st.cycle_row_cap is not null then
    v_pace := greatest(0, st.cycle_row_cap - v_rows_cycle) / v_days_left;
    v_allowed := least(v_allowed, v_pace, greatest(0, st.cycle_row_cap - v_rows_cycle));
  else
    v_pace := null;
  end if;

  if st.paused then
    v_allowed := 0;
  end if;

  return jsonb_build_object(
    'configured', true,
    'paused', st.paused,
    'cycle_start', v_cycle_start,
    'cycle_end', (v_cycle_end_d::timestamp) at time zone 'utc',
    'days_left_in_cycle', v_days_left,
    'rows_cycle', v_rows_cycle,
    'rows_today', v_rows_today,
    'datapoints_est_cycle', v_dp_cycle,
    'datapoints_est_today', v_dp_today,
    'day_row_cap', st.day_row_cap,
    'cycle_row_cap', st.cycle_row_cap,
    'pace_rows_per_day', v_pace,
    'rows_allowed_now', v_allowed
  );
end;
$$;

-- ⚠ All three roles, not just PUBLIC: this DB carries ALTER DEFAULT PRIVILEGES
-- grants for anon and authenticated, so the explicit rows survive a PUBLIC-only
-- revoke. (EXECUTE is the only privilege a function has, so this is exactly what
-- the applied `REVOKE ALL` did — verified live: has_function_privilege('anon',
-- 'public.dune_budget_status()', 'EXECUTE') = false.)
revoke execute on function public.dune_budget_status() from public, anon, authenticated;
grant execute on function public.dune_budget_status() to service_role;

comment on function public.dune_budget_status() is
  'Dune spend policy + ledger, in one read. rows_allowed_now is what a lane may '
  'still buy right now; 0 means stop. Fails CLOSED (0) when unconfigured.';

-- REVERT:
--   drop function if exists public.dune_budget_status();
--   drop table if exists public.dune_api_usage;
--   drop table if exists public.dune_budget_state;
-- (Routes treat an unreadable budget as 0 and skip, so revert the code first.)
