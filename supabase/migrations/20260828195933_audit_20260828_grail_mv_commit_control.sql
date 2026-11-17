do $$
begin
  -- ANCHOR ASSERT 1: the matview this instrument observes must exist.
  if to_regclass('public.pack_grail_metrics_mv') is null then
    raise exception 'anchor missing: public.pack_grail_metrics_mv not found — aborting';
  end if;
  -- ANCHOR ASSERT 2: collision guard. Several sessions write into the
  -- audit_20260828_ prefix; refuse to clobber an existing relation.
  if to_regclass('public.audit_20260828_grail_mv_commit_control') is not null then
    raise exception 'collision: public.audit_20260828_grail_mv_commit_control already exists — aborting';
  end if;
  -- ANCHOR ASSERT 3: the heartbeat pipeline must already be emitting, or this
  -- instrument cannot classify a tick as killed vs succeeded.
  if not exists (
    select 1 from public.pipeline_runs
    where pipeline = 'refresh-pack-grail-metrics-mv-heartbeat'
      and started_at > now() - interval '6 hours'
  ) then
    raise exception 'anchor missing: no refresh-pack-grail-metrics-mv-heartbeat row in the last 6h — aborting';
  end if;
end $$;

create table public.audit_20260828_grail_mv_commit_control (
  at               timestamptz primary key,
  n_tup_ins        bigint not null,
  n_tup_del        bigint not null,
  last_autoanalyze timestamptz,
  last_hb_at       timestamptz,
  last_terminal_at timestamptz
);

comment on table public.audit_20260828_grail_mv_commit_control is
  'Decides ONE question: when the hourly :23 refresh-pack-grail-metrics-mv tick is KILLED at the route''s maxDuration=60 (heartbeat row present, terminal row absent), does the REFRESH MATERIALIZED VIEW CONCURRENTLY still COMMIT server-side? n_tup_ins/n_tup_del on pack_grail_metrics_mv move ONLY on a refresh (nothing else writes a matview), so a non-zero delta across a killed tick proves the data landed and the loss is LOGGING ONLY. Sampled at :21 (pre-tick baseline), :27 and :33. Self-unschedules 2026-08-31 12:00Z. Retire with the named revert in the ledger entry — never a wildcard drop on the audit_20260828_ prefix.';

alter table public.audit_20260828_grail_mv_commit_control enable row level security;

revoke all on table public.audit_20260828_grail_mv_commit_control from public, anon, authenticated;
grant select, insert on table public.audit_20260828_grail_mv_commit_control to service_role;

create function public.audit_20260828_sample_grail_mv_commit()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_ins   bigint;
  v_del   bigint;
  v_ana   timestamptz;
  v_hb    timestamptz;
  v_term  timestamptz;
begin
  if now() > timestamptz '2026-08-31 12:00:00+00' then
    perform cron.unschedule('rpc-audit-grail-mv-commit-control');
    return;
  end if;

  -- schema-qualified rather than widening this SECDEF function's search_path
  select s.n_tup_ins, s.n_tup_del, s.last_autoanalyze
    into v_ins, v_del, v_ana
  from pg_catalog.pg_stat_all_tables s
  where s.schemaname = 'public' and s.relname = 'pack_grail_metrics_mv';

  -- stats reset or relation gone: skip rather than write a false zero
  if v_ins is null then
    return;
  end if;

  select max(started_at) into v_hb
  from public.pipeline_runs
  where pipeline = 'refresh-pack-grail-metrics-mv-heartbeat';

  select max(started_at) into v_term
  from public.pipeline_runs
  where pipeline = 'refresh-pack-grail-metrics-mv';

  insert into public.audit_20260828_grail_mv_commit_control
    (at, n_tup_ins, n_tup_del, last_autoanalyze, last_hb_at, last_terminal_at)
  values (now(), v_ins, v_del, v_ana, v_hb, v_term)
  on conflict (at) do nothing;
end
$fn$;

revoke execute on function public.audit_20260828_sample_grail_mv_commit() from public, anon, authenticated;
grant execute on function public.audit_20260828_sample_grail_mv_commit() to postgres, service_role;