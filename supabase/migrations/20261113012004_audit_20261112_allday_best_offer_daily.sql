-- audit_20261112_allday_best_offer_daily — 2026-11-12 ~5:20 PM PT (Cowork cloud; Trevor 5:08 PM PT: "Keep going and
-- refining and enhancing this fmv engine ... for every collection we support").
--
-- WHY. Top Shot's offer pull (audit_20261112_topshot_thin_price_pulled_toward_best_offer) was decided on a backtest that
-- needs the bid IN FORCE BEFORE each sale. Top Shot has that (`offers` keeps created / resolved / expires). All Day does
-- not: `allday_open_offers` holds the open book only, so "does a thin All Day edition also sell at its standing offer?"
-- cannot be answered from history. This keeps one row per edition per PT day (best open bid, number of offers) so the
-- same backtest can be run on All Day after ~2 weeks. It changes no price.
-- Written by capture_allday_best_offers(); a re-run the same day refreshes that day's rows. Scheduled 2026-11-12 6:58 PM PT in the
-- dashboard SQL editor (Trevor: "You run it in chrome") after the MCP refused cron.schedule: pg_cron jobid 871,
--   select cron.schedule('rpc-capture-allday-best-offers', '20 13 * * *', $c$select public.capture_allday_best_offers()$c$);
-- (5:20 AM PT daily) + a pipeline_cadence_watchlist row 'allday-best-offer-daily' (1,560 / 3,000 min, info).
-- First day 2026-11-12 was hand-run (2,198 editions).
-- anon-exec: capture_allday_best_offers is NOT anon-executable (EXECUTE revoked from public, anon, authenticated).
-- Revert: none needed (nothing reads it); unschedule rpc-capture-allday-best-offers if it was scheduled.
create table if not exists public.allday_best_offer_daily (
  day                 date        not null,
  edition_external_id text        not null,
  best_bid            numeric     not null,
  n_offers            integer     not null,
  captured_at         timestamptz not null default now(),
  primary key (day, edition_external_id)
);
alter table public.allday_best_offer_daily enable row level security;
revoke all on public.allday_best_offer_daily from public, anon, authenticated;
comment on table public.allday_best_offer_daily is
  'One row per NFL All Day edition per PT day: the best open offer (allday_open_offers) at capture time. History for backtesting bid-aware pricing; no reader prices from it. Writer: capture_allday_best_offers() (daily pg_cron).';

create or replace function public.capture_allday_best_offers()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_started timestamptz := clock_timestamp();
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_n integer;
  v_ok boolean;
  v_err text;
begin
  begin
    insert into public.allday_best_offer_daily as t (day, edition_external_id, best_bid, n_offers, captured_at)
    select v_day, o.edition_id, max(o.amount), count(*)::int, now()
      from public.allday_open_offers o
     where o.edition_id is not null and o.amount > 0
     group by o.edition_id
    on conflict (day, edition_external_id) do update
      set best_bid = excluded.best_bid, n_offers = excluded.n_offers, captured_at = excluded.captured_at;
    get diagnostics v_n = row_count;
    v_ok := coalesce(v_n, 0) > 0;
    if not v_ok then v_err := 'allday_open_offers returned no open offers'; end if;
  exception when query_canceled or others then
    v_ok := false;
    v_err := sqlerrm;
  end;
  perform public.log_pipeline_run('allday-best-offer-daily', v_started, v_n, v_n, NULL, v_ok, v_err,
    NULL, NULL, NULL, jsonb_build_object('day', v_day));
  return jsonb_build_object('ok', v_ok, 'rows_written', v_n, 'error', v_err);
end $fn$;
revoke all on function public.capture_allday_best_offers() from public, anon, authenticated;
