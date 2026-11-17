-- anon-exec: fmv_snapshots_floor_allday_at_best_offer is NOT anon-executable (EXECUTE revoked).
-- Applied first via the dashboard SQL editor (~8:10 AM PT 11-12, FMV comparables session) with no history row;
-- re-recorded verbatim by Cowork (~8:35 AM PT) so the migration history and autorecover can see it.
-- CREATE OR REPLACE TRIGGER makes the re-apply idempotent (live prosrc md5 117190dfb1b3c3bc9137d1f7ac0a2039 before).
create or replace function public.fmv_snapshots_floor_allday_at_best_offer()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_allday constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_bid numeric;
begin
  if new.collection_id = c_allday
     and new.fmv_usd is not null and new.fmv_usd > 0
     and new.edition_id is not null
  then
    select max(o.amount) into v_bid
      from public.editions e
      join public.allday_open_offers o on o.edition_id = e.external_id
     where e.id = new.edition_id and e.collection_id = c_allday;
    if v_bid is not null and v_bid > new.fmv_usd and v_bid <= 3 * new.fmv_usd then
      new.fmv_usd := round(v_bid, 2);
      new.algo_version := coalesce(new.algo_version, '') || '_bidfloor';
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public.fmv_snapshots_floor_allday_at_best_offer() from public, anon, authenticated;
create or replace trigger fmv_snapshots_floor_allday_at_best_offer_trg
  before insert on public.fmv_snapshots
  for each row execute function public.fmv_snapshots_floor_allday_at_best_offer();