-- NFL All Day: an ASK_ONLY or STALE price is capped at the edition's comparable-edition estimate (comp-1.0),
-- suffix "_compcap". 2026-11-12, Cowork, under Trevor's "work on developing and improving our FMV engine for each
-- collection ... predictive fmv for moments without sales yet".
--
-- Measured (sales_market, serial > 25, snapshot in force >= 1 day before the sale, estimate basis = set, n_set >= 3):
--   ASK_ONLY with no sales cap binding  (30 d, n 272): published ratio 1.80-1.95, within +/-25 % 22-26 %, WAPE 122-177
--                                                      min(published, comp) 1.04-1.05, 39-47 %, WAPE 48-74
--   ASK_ONLY already _salescap          (30 d, n 250): within +/-25 % 38.8 -> 46.6 (d9-30) and 51.5 -> 56.7 (last 8 d)
--   STALE                               (d9-30, n 31): ratio 3.42 -> 1.00, within +/-25 % 9.7 -> 25.8, WAPE 244 -> 57
--   By price band (45 d): the cap wins in every band with n >= 9, incl. $50+ at a 5x+ cut (ratio 8.72 -> 0.63).
-- All Day ONLY by measurement: on Top Shot the same cap loses within +/-25 % (53.9 -> 46.7); Golazos published wins.
-- The cap only LOWERS a price. It fails open: no estimate, a non-set basis, < 3 set-mates, or an estimate older than
-- 3 days leaves the row untouched.
-- Order: the trigger name sorts BEFORE fmv_snapshots_cap_allday_ask_only_to_recent_sales_trg on purpose, so a later
-- _salescap / _stalecap suffix stays LAST and get_edition_detail's basis_capped regex keeps matching.
-- anon-exec: fmv_snapshots_cap_allday_thin_to_comparables is NOT anon-executable (EXECUTE revoked).
-- Revert: disable or remove trigger fmv_snapshots_cap_allday_a_comparables_trg on fmv_snapshots; the next writer pass
-- re-inserts uncapped rows (ASK_ONLY rows are re-written every few hours).
-- Falsifier: fmv_sales_backtest('nfl_all_day', 7) ASK_ONLY within_25 below its 11-12 value (45.1 on 14 d) two weeks running.
create or replace function public.fmv_snapshots_cap_allday_thin_to_comparables()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_allday constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_est numeric;
begin
  if new.collection_id = c_allday
     and new.confidence in ('ASK_ONLY', 'STALE')
     and new.fmv_usd is not null and new.fmv_usd > 0
     and new.edition_id is not null
  then
    select m.est_usd into v_est
      from public.fmv_comparable_estimates m
     where m.edition_id = new.edition_id
       and m.baseline_kind = 'set' and m.n_set >= 3
       and m.est_usd >= 0.01
       and m.computed_at > now() - interval '3 days';
    if v_est is not null and new.fmv_usd > v_est then
      new.fmv_usd := round(v_est, 2);
      new.algo_version := coalesce(new.algo_version, '') || '_compcap';
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public.fmv_snapshots_cap_allday_thin_to_comparables() from public, anon, authenticated;

create trigger fmv_snapshots_cap_allday_a_comparables_trg
  before insert on public.fmv_snapshots
  for each row execute function public.fmv_snapshots_cap_allday_thin_to_comparables();