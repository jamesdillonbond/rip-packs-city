-- audit_20260822_dune_two_meter_budget_and_allocation
--
-- Second pass on the Dune budget shipped earlier today. That one capped ROWS per
-- UTC day, because the plan's real limit was unknown. It is now known, and the
-- arithmetic changes what the budget has to do.
--
-- 🚨 THE NUMBER THAT DECIDES EVERYTHING. Plan limits (operator-confirmed
-- 2026-08-22): **1,000,000 datapoints and 2,500 credits per billing cycle.**
-- One full `ownership-sync-dune` walk is 114,083 rows x 6 columns =
-- **684,498 datapoints — 68.4% of the entire cycle in a single run.** So the
-- weekly cadence that lane has been on is not merely wasteful, it is
-- ARITHMETICALLY IMPOSSIBLE: 4.3 walks/cycle would need ~2.9M datapoints against
-- a 1M cap. The 402s on 08-10 and 08-17 were not a mystery; they were the second
-- walk of the month meeting a limit the first walk had already spent.
--
-- ── TWO METERS, NOT ONE ────────────────────────────────────────────────────
-- ⚠ They are consumed by DIFFERENT lanes and neither predicts the other.
--   * DATAPOINTS are bought by /results pages, and are dominated by the single
--     ownership walk (684k of 1M).
--   * CREDITS are bought by /execute, one per window, and are dominated by the
--     CURSORED lanes — `sales-ingest-dune` ran 37 windows and
--     `sales-seller-recovery-dune` 43 in one 2026-07-24 morning. The credits
--     gauge read ~900 of 2,500 after roughly 80 executions, which calibrates
--     `credits_per_execution` at ~11; 10 is the conservative default below and it
--     is an ESTIMATE (Dune prices an execution by engine, and we cannot read the
--     charge back), so it is named `_est` everywhere it is reported.
-- Capping rows alone would have let the cursored lanes burn every credit while
-- the datapoint meter still looked healthy — which is exactly the shape of the
-- July burn, where the credits gauge and the datapoint limit disagreed.
--
-- ── ALLOCATION: OWNERSHIP FIRST, THE REST IS A SHARED POOL ─────────────────
-- Operator decision, 2026-08-22. `ownership-sync-dune` gets a RESERVATION no
-- other lane can spend, sized at one full walk plus headroom (700,000). The
-- remaining ~300,000 is a free pool for the backfill lanes and for ad-hoc
-- dune.com / MCP work.
--
-- ⚠ A RESERVATION IS NOT A GRANT. It only stops OTHER lanes eating it; the
-- reserved lane still pays from the same global cap, so a manual query that
-- spends 900k still starves ownership. The pool is protected against the crons,
-- not against a human.
--
-- ⚠ `min_start_datapoints` IS THE PART THAT MAKES THIS SAFE FOR THE WALK. The
-- ownership walk restarts at offset 0 every run, so a run that stops half way
-- has bought rows AND left the table capped at the offset it reached (this is
-- recorded in the route: an abort at offset 20000 "permanently capped the
-- table"). A lane whose work is atomic must therefore DECLINE TO START unless it
-- can finish — never spend 300k on 44% of a walk.

-- ── The two meters ────────────────────────────────────────────────────────
alter table public.dune_budget_state
  add column if not exists cycle_datapoint_cap  bigint,
  add column if not exists cycle_credit_cap     bigint,
  add column if not exists credits_per_execution integer not null default 10,
  add column if not exists day_datapoint_cap    bigint;

update public.dune_budget_state
   set cycle_datapoint_cap = coalesce(cycle_datapoint_cap, 1000000),
       cycle_credit_cap    = coalesce(cycle_credit_cap, 2500),
       -- One full ownership walk (684,498) fits in a day; a second does not.
       day_datapoint_cap   = coalesce(day_datapoint_cap, 750000),
       note = 'Free plan: 1,000,000 datapoints + 2,500 credits per cycle, reset day 24 (operator-confirmed 2026-08-22).',
       updated_at = now()
 where id = 1;

comment on column public.dune_budget_state.credits_per_execution is
  'ESTIMATE. Dune prices an execution by engine and we cannot read the charge back. '
  '10 is conservative against the ~11/execution implied by ~900 credits over ~80 '
  'executions on 2026-07-24. Never reported without the _est suffix.';

-- ── Per-lane allocation ───────────────────────────────────────────────────
create table if not exists public.dune_budget_allocation (
  pipeline              text primary key,
  -- Datapoints no OTHER lane may spend. Sized at one atomic unit of this lane's
  -- work, where the work is atomic.
  reserved_datapoints   bigint  not null default 0 check (reserved_datapoints >= 0),
  -- Hard ceiling for this lane per cycle. NULL = may use whatever the global cap
  -- and other lanes' reservations leave.
  cap_datapoints        bigint  check (cap_datapoints is null or cap_datapoints >= 0),
  -- Refuse to START below this. For a lane whose walk restarts at offset 0, a
  -- partial run is worse than no run: it spends and leaves the table capped.
  min_start_datapoints  bigint  not null default 0 check (min_start_datapoints >= 0),
  enabled               boolean not null default true,
  note                  text,
  updated_at            timestamptz not null default now()
);

insert into public.dune_budget_allocation
  (pipeline, reserved_datapoints, cap_datapoints, min_start_datapoints, enabled, note)
values
  ('ownership-sync-dune', 700000, 700000, 600000, true,
   'One full walk = 114,083 rows x 6 cols = 684,498 dp (68.4% of the cycle). Reserved so the backfill lanes cannot eat it; min_start refuses a partial walk, which would spend AND leave the table capped at the offset reached.'),
  ('sales-seller-recovery-dune', 0, 300000, 0, true,
   'Free pool only. DRAINED since 2026-07-26 (cursor_end == floor_date), so it spends nothing today; the cap binds if its floor is ever lowered.'),
  ('sales-ingest-dune', 0, 300000, 0, true,
   'Free pool only. Burned the 2026-07-24 cycle: ~636,956 rows over 37 windows, 90.2% discarded as skipped_unresolved. Schedule retired 07-28; the cap is what makes reviving it safe.')
on conflict (pipeline) do nothing;

alter table public.dune_budget_allocation enable row level security;
revoke all on table public.dune_budget_allocation from public, anon, authenticated;
grant select on table public.dune_budget_allocation to service_role;

comment on table public.dune_budget_allocation is
  'Per-lane Dune allocation. reserved_datapoints is protected from OTHER lanes '
  '(not from a human running queries on dune.com); cap_datapoints is this lane''s '
  'ceiling; min_start_datapoints refuses a run that cannot finish its atomic unit.';

-- ── The gate, now two-metered and per-lane ────────────────────────────────
-- anon-exec: revoked below (dune_budget_status) — service_role only, same as v1.
create or replace function public.dune_budget_status(p_pipeline text default null)
returns jsonb
language plpgsql
stable
as $$
declare
  st                public.dune_budget_state%rowtype;
  al                public.dune_budget_allocation%rowtype;
  v_today           date;
  v_anchor_this     date;
  v_cycle_start_d   date;
  v_cycle_end_d     date;
  v_cycle_start     timestamptz;
  v_day_start       timestamptz;
  v_dp_cycle        bigint;
  v_rows_cycle      bigint;
  v_exec_cycle      bigint;
  v_dp_today        bigint;
  v_rows_today      bigint;
  v_dp_pipeline     bigint;
  v_credits_est     bigint;
  v_credits_left    bigint;
  v_global_left     bigint;
  v_others_reserved bigint;
  v_available       bigint;
  v_pipeline_left   bigint;
  v_day_left        bigint;
  v_allowed         bigint;
  v_days_left       integer;
begin
  select * into st from public.dune_budget_state where id = 1;

  -- ⚠ A MISSING CONFIG ROW IS NOT "UNLIMITED". Fail closed: an absent policy
  -- means we cannot prove there is budget, and the failure this exists to
  -- prevent is spending a month in a morning.
  if not found then
    return jsonb_build_object(
      'configured', false, 'paused', false,
      'rows_allowed_now', 0, 'datapoints_allowed_now', 0, 'can_start', false,
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
  v_day_start   := (v_today::timestamp) at time zone 'utc';
  v_days_left   := greatest(1, v_cycle_end_d - v_today);

  -- sum() over zero ledger rows is a genuine "nothing spent yet".
  select coalesce(sum(datapoints_est), 0), coalesce(sum(rows_returned), 0),
         count(*) filter (where endpoint = 'execute')
    into v_dp_cycle, v_rows_cycle, v_exec_cycle
    from public.dune_api_usage
   where occurred_at >= v_cycle_start;

  select coalesce(sum(datapoints_est), 0), coalesce(sum(rows_returned), 0)
    into v_dp_today, v_rows_today
    from public.dune_api_usage
   where occurred_at >= v_day_start;

  v_credits_est  := v_exec_cycle * st.credits_per_execution;
  v_credits_left := case when st.cycle_credit_cap is null then null
                         else greatest(0, st.cycle_credit_cap - v_credits_est) end;

  if p_pipeline is null then
    v_dp_pipeline := null;
    al := null;
  else
    select * into al from public.dune_budget_allocation where pipeline = p_pipeline;
    select coalesce(sum(datapoints_est), 0) into v_dp_pipeline
      from public.dune_api_usage
     where occurred_at >= v_cycle_start and pipeline = p_pipeline;
  end if;

  v_global_left := case when st.cycle_datapoint_cap is null then null
                        else greatest(0, st.cycle_datapoint_cap - v_dp_cycle) end;

  -- ⚠ Every OTHER lane's UNSPENT reservation is subtracted from what this lane
  -- may take. That, and nothing else, is what "ownership first" means: the
  -- backfill lanes see a smaller pool, not a polite request.
  select coalesce(sum(greatest(0, a.reserved_datapoints - coalesce(u.spent, 0))), 0)
    into v_others_reserved
    from public.dune_budget_allocation a
    left join (
      select pipeline, sum(datapoints_est) as spent
        from public.dune_api_usage
       where occurred_at >= v_cycle_start
       group by pipeline
    ) u on u.pipeline = a.pipeline
   where a.enabled and (p_pipeline is null or a.pipeline <> p_pipeline);

  v_available := case when v_global_left is null then null
                      else greatest(0, v_global_left - v_others_reserved) end;

  v_pipeline_left := case
    when al.pipeline is null then v_available
    when al.cap_datapoints is null then v_available
    else least(coalesce(v_available, al.cap_datapoints),
               greatest(0, al.cap_datapoints - coalesce(v_dp_pipeline, 0)))
  end;

  v_day_left := case when st.day_datapoint_cap is null then null
                     else greatest(0, st.day_datapoint_cap - v_dp_today) end;

  v_allowed := coalesce(least(
    coalesce(v_pipeline_left, 9223372036854775807),
    coalesce(v_day_left,      9223372036854775807)
  ), 0);

  -- A lane switched off in the allocation table, or the global kill switch, or a
  -- spent credit meter: all three are a hard zero. ⚠ The CREDIT meter zeroes the
  -- DATAPOINT allowance too, because a lane that cannot execute can only serve a
  -- stale cached execution — which is precisely the spend that bought nothing.
  if st.paused
     or (al.pipeline is not null and not al.enabled)
     or (v_credits_left is not null and v_credits_left <= 0) then
    v_allowed := 0;
  end if;

  return jsonb_build_object(
    'configured', true,
    'paused', st.paused,
    'pipeline', p_pipeline,
    'cycle_start', v_cycle_start,
    'cycle_end', (v_cycle_end_d::timestamp) at time zone 'utc',
    'days_left_in_cycle', v_days_left,
    'cycle_datapoint_cap', st.cycle_datapoint_cap,
    'datapoints_cycle', v_dp_cycle,
    'datapoints_today', v_dp_today,
    'rows_cycle', v_rows_cycle,
    'rows_today', v_rows_today,
    'global_datapoints_left', v_global_left,
    'reserved_for_other_lanes', v_others_reserved,
    'cycle_credit_cap', st.cycle_credit_cap,
    'executions_cycle', v_exec_cycle,
    'credits_est_cycle', v_credits_est,
    'credits_est_left', v_credits_left,
    'pipeline_reserved', al.reserved_datapoints,
    'pipeline_cap', al.cap_datapoints,
    'pipeline_datapoints_cycle', v_dp_pipeline,
    'pipeline_enabled', coalesce(al.enabled, true),
    'min_start_datapoints', coalesce(al.min_start_datapoints, 0),
    'datapoints_allowed_now', v_allowed,
    -- Kept for the secondary rows/day bound the v1 routes read.
    'day_row_cap', st.day_row_cap,
    'rows_allowed_now', greatest(0, st.day_row_cap - v_rows_today),
    -- ⚠ can_start is NOT "allowance > 0". A lane whose walk restarts at offset 0
    -- must be able to finish, or it spends and leaves the table capped.
    'can_start', v_allowed >= coalesce(al.min_start_datapoints, 0) and v_allowed > 0
  );
end;
$$;

revoke execute on function public.dune_budget_status(text) from public, anon, authenticated;
grant execute on function public.dune_budget_status(text) to service_role;

-- The zero-arg v1 signature is superseded. Dropping it rather than leaving two
-- overloads: an overload set is exactly how a caller silently keeps hitting the
-- old contract after the new one ships.
drop function if exists public.dune_budget_status();

-- ── The monitoring read ───────────────────────────────────────────────────
-- anon-exec: revoked below (dune_spend_report) — read by the sentinel as service_role.
create or replace function public.dune_spend_report()
returns jsonb
language plpgsql
stable
as $$
declare
  base      jsonb;
  v_start   timestamptz;
  v_end     timestamptz;
  v_days    numeric;
  v_elapsed numeric;
  v_dp      bigint;
  v_cap     bigint;
  by_lane   jsonb;
begin
  base := public.dune_budget_status(null);
  if (base->>'configured') is distinct from 'true' then
    return base;
  end if;

  v_start := (base->>'cycle_start')::timestamptz;
  v_end   := (base->>'cycle_end')::timestamptz;
  v_dp    := (base->>'datapoints_cycle')::bigint;
  v_cap   := nullif(base->>'cycle_datapoint_cap', '')::bigint;
  v_days  := greatest(1, extract(epoch from (v_end - v_start)) / 86400.0);
  v_elapsed := greatest(0.01, extract(epoch from (now() - v_start)) / 86400.0);

  select coalesce(jsonb_agg(x order by x->>'pipeline'), '[]'::jsonb) into by_lane
  from (
    select jsonb_build_object(
             'pipeline', a.pipeline,
             'reserved_datapoints', a.reserved_datapoints,
             'cap_datapoints', a.cap_datapoints,
             'enabled', a.enabled,
             'datapoints_cycle', coalesce(u.dp, 0),
             'rows_cycle', coalesce(u.rows_n, 0),
             'executions_cycle', coalesce(u.execs, 0),
             'last_call_at', u.last_at
           ) as x
      from public.dune_budget_allocation a
      left join (
        select pipeline,
               sum(datapoints_est) as dp,
               sum(rows_returned)  as rows_n,
               count(*) filter (where endpoint = 'execute') as execs,
               max(occurred_at) as last_at
          from public.dune_api_usage
         where occurred_at >= v_start
         group by pipeline
      ) u on u.pipeline = a.pipeline
  ) s;

  return base || jsonb_build_object(
    'by_pipeline', by_lane,
    'cycle_elapsed_pct', round(100.0 * v_elapsed / v_days, 1),
    'cycle_datapoints_pct', case when v_cap is null or v_cap = 0 then null
                                 else round(100.0 * v_dp / v_cap, 1) end,
    -- ⚠ A BURN-RATE PROJECTION, NOT A PREDICTION. It extrapolates the cycle's
    -- average, and this estimate's dominant term is one weekly 684k walk, so it
    -- swings hard right after a walk lands. Read it beside cycle_datapoints_pct,
    -- never alone.
    'projected_cycle_datapoints', round(v_dp * v_days / v_elapsed),
    'on_pace', case
      when v_cap is null then null
      else round(v_dp * v_days / v_elapsed) <= v_cap
    end
  );
end;
$$;

revoke execute on function public.dune_spend_report() from public, anon, authenticated;
grant execute on function public.dune_spend_report() to service_role;

comment on function public.dune_spend_report() is
  'Dune cycle spend for the sentinel: both meters, per-lane breakdown, elapsed vs '
  'spent, and a burn-rate projection that is an extrapolation, not a prediction.';

-- REVERT:
--   drop function if exists public.dune_spend_report();
--   drop function if exists public.dune_budget_status(text);
--   drop table if exists public.dune_budget_allocation;
--   alter table public.dune_budget_state
--     drop column if exists cycle_datapoint_cap,
--     drop column if exists cycle_credit_cap,
--     drop column if exists credits_per_execution,
--     drop column if exists day_datapoint_cap;
--   -- then recreate the v1 zero-arg dune_budget_status() from
--   -- 20260822230000_audit_20260822_dune_datapoint_budget_ledger.sql
--   -- ⚠ Revert the CODE first: the routes read the (text) signature.
