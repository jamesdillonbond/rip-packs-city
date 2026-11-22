-- audit_20261122_panini_edition_supply_obs_pull_ledger
--
-- Trevor 2026-11-22 9:26 AM PT "Keep going and digging and probing and come up with a strategy" → strategy doc
-- docs/strategy/panini-pack-ev-strategy-2026-11-22.md, item P0.3 (the pull ledger).
--
-- WHY: no Panini pack-EV number has ever been backtested — we never observe a pull. panini_editions carries Panini's
-- own still_in_packs / pulled_count per card but keeps only the CURRENT value, so every walk overwrites the evidence
-- of what was pulled since the last one. This records each observed value (≈7.6k card updates/day, 54k cards):
-- day-over-day drops in still_in_packs are realized pulls; valued at later sales they give realized value per opened
-- pack, the ground truth pack EV has never had. Pack-level counts already have history (panini_pack_state_history).
--
-- WHAT: table panini_edition_supply_obs (one row per card per observed update; append-only, ON CONFLICT DO NOTHING),
-- recorder record_panini_edition_supply_obs() reading rows whose updated_at is past the newest stored observation
-- (5-min overlap), pg_cron hourly at :54 (a measured-quiet minute). First run stores a baseline of every card.
-- Size: ~7.6k rows/day.
--
-- anon-exec: new (record_panini_edition_supply_obs) — revoked FROM PUBLIC, anon, authenticated below; service_role/postgres only.
--
-- REVERT: select cron.unschedule('panini-edition-supply-obs');
--         drop function public.record_panini_edition_supply_obs(); drop table public.panini_edition_supply_obs;

create table if not exists public.panini_edition_supply_obs (
  external_id     text        not null,
  observed_at     timestamptz not null,
  still_in_packs  integer,
  pulled_count    integer,
  burned_count    integer,
  recorded_at     timestamptz not null default now(),
  primary key (external_id, observed_at)
);
alter table public.panini_edition_supply_obs enable row level security;
revoke all on public.panini_edition_supply_obs from public, anon, authenticated;
grant select on public.panini_edition_supply_obs to service_role;
create index if not exists panini_edition_supply_obs_observed_at_idx on public.panini_edition_supply_obs (observed_at);
comment on table public.panini_edition_supply_obs is
  'Pull ledger (2026-11-22): each observed value of panini_editions.still_in_packs / pulled_count / burned_count, stamped with the card row''s updated_at. Day-over-day drops in still_in_packs are realized pulls — ground truth for backtesting pack EV. Written hourly by record_panini_edition_supply_obs().';

create or replace function public.record_panini_edition_supply_obs()
 returns jsonb
 language plpgsql
 set search_path to 'public', 'pg_temp'
 set statement_timeout to '60s'
as $function$
declare
  v_started timestamptz := clock_timestamp();
  v_since   timestamptz;
  v_written integer := 0;
begin
  select max(observed_at) - interval '5 minutes' into v_since from panini_edition_supply_obs;

  insert into panini_edition_supply_obs (external_id, observed_at, still_in_packs, pulled_count, burned_count)
  select e.external_id, e.updated_at, e.still_in_packs, e.pulled_count, e.burned_count
    from panini_editions e
   where e.updated_at is not null
     and (v_since is null or e.updated_at > v_since)
  on conflict (external_id, observed_at) do nothing;
  get diagnostics v_written = row_count;

  perform public.log_pipeline_run('panini-edition-supply-obs', true,
    jsonb_build_object('upserted', v_written, 'since', v_since,
                       'ms', round(extract(epoch from clock_timestamp() - v_started) * 1000)));
  return jsonb_build_object('ok', true, 'written', v_written, 'since', v_since);
exception when query_canceled or others then
  perform public.log_pipeline_run('panini-edition-supply-obs', false, jsonb_build_object('error', sqlerrm));
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;
revoke execute on function public.record_panini_edition_supply_obs() from public, anon, authenticated;
grant execute on function public.record_panini_edition_supply_obs() to postgres, service_role;

select cron.schedule('panini-edition-supply-obs', '54 * * * *', $$select public.record_panini_edition_supply_obs()$$);