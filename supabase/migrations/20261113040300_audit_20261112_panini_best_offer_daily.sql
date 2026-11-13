-- audit_20261112_panini_best_offer_daily — 2026-11-12 ~8:03 PM PT (Cowork cloud; Trevor 8:02 PM PT: "Do what you think is
-- best and keep going and see everything through. Make decisions based upon what's best for RPC long term and for our users").
--
-- WHY. Panini is the weakest collection on the accuracy scoreboard (45 % of sales within +/-25 % of the price), and the
-- error sits in cards with under 100 copies (cap 100+: 57-62 %; cap 26-99: 46 %; cap <= 25: 26 %), where no rule built
-- from the edition's own sales helps (11-12 read, Project doc "Panini pricing accuracy"). On Top Shot the signal that
-- fixed thin editions was the standing OFFER (20261113012028). Panini has one — panini_card_serials.best_offer_usd,
-- the same value on every copy for 4,642 of 4,812 editions — but the table is current state only, so "does a scarce
-- Panini card sell at its standing offer?" cannot be answered from history. This keeps one row per edition per PT day.
-- It changes no price.
-- Cost (measured): index-only over idx_panini_serials_offer_edition, ~405k cards, 37k buffers, ~5 s.
-- First day 2026-11-12, hand-run: 4,812 editions (median offer = 53 % of our price; 333 with an offer ABOVE our price).
-- ⚠ NOT SCHEDULED: cron.schedule was refused from this session (MCP and SQL editor). Until Trevor runs
--   select cron.schedule('rpc-capture-panini-best-offers', '25 13 * * *', $c$select public.capture_panini_best_offers()$c$);
-- (and adds a pipeline_cadence_watchlist row 'panini-best-offer-daily', 1560 / 3000 min, info) only hand-run days exist.
-- anon-exec: capture_panini_best_offers is NOT anon-executable (EXECUTE revoked from public, anon, authenticated).
-- Revert: none needed (nothing reads it).
create table if not exists public.panini_best_offer_daily (
  day                 date        not null,
  edition_external_id text        not null,
  best_offer_usd      numeric     not null,
  min_offer_usd       numeric     not null,
  n_cards_with_offer  integer     not null,
  newest_seen_at      timestamptz,
  captured_at         timestamptz not null default now(),
  primary key (day, edition_external_id)
);
alter table public.panini_best_offer_daily enable row level security;
revoke all on public.panini_best_offer_daily from public, anon, authenticated;
comment on table public.panini_best_offer_daily is
  'One row per Panini edition per PT day: the best and lowest per-card offer (panini_card_serials.best_offer_usd, cards re-read in the last 7 days) at capture time. History for backtesting offer-aware pricing; no reader prices from it. Writer: capture_panini_best_offers() (daily pg_cron).';

create or replace function public.capture_panini_best_offers()
returns jsonb language plpgsql security definer set search_path = public, pg_temp
set statement_timeout to '120s' as $fn$
declare
  v_started timestamptz := clock_timestamp();
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_n integer;
  v_ok boolean;
  v_err text;
begin
  begin
    insert into public.panini_best_offer_daily as t
      (day, edition_external_id, best_offer_usd, min_offer_usd, n_cards_with_offer, newest_seen_at, captured_at)
    select v_day, s.edition_external_id, max(s.best_offer_usd), min(s.best_offer_usd), count(*)::int, max(s.captured_at), now()
      from public.panini_card_serials s
     where s.best_offer_usd > 0
       and s.captured_at > now() - interval '7 days'
       and s.edition_external_id is not null
     group by s.edition_external_id
    on conflict (day, edition_external_id) do update
      set best_offer_usd = excluded.best_offer_usd, min_offer_usd = excluded.min_offer_usd,
          n_cards_with_offer = excluded.n_cards_with_offer, newest_seen_at = excluded.newest_seen_at,
          captured_at = excluded.captured_at;
    get diagnostics v_n = row_count;
    v_ok := coalesce(v_n, 0) > 0;
    if not v_ok then v_err := 'no Panini card carries a fresh offer'; end if;
  exception when query_canceled or others then
    v_ok := false;
    v_err := sqlerrm;
  end;
  perform public.log_pipeline_run('panini-best-offer-daily', v_started, v_n, v_n, NULL, v_ok, v_err,
    NULL, NULL, NULL, jsonb_build_object('day', v_day));
  return jsonb_build_object('ok', v_ok, 'rows_written', v_n, 'error', v_err);
end $fn$;
revoke all on function public.capture_panini_best_offers() from public, anon, authenticated;
