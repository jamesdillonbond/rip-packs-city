-- NFL All Day: the best-open-offer floor also holds a later price CUT. 2026-11-12 ~8:33 AM PT, Cowork (Trevor:
-- "Keep working through all of this"). APPLIED IN THE DASHBOARD SQL EDITOR (Trevor: "Use chrome to do the SQL");
-- no supabase_migrations.schema_migrations row exists for this name. This REPLACES the body recorded as
-- 20261112162628 (insert-only) -- that file is history, this one is the live body.
--
-- WHY. Read 8:26 AM PT: 190 of 638 latest All Day _haircut rows sat under an open offer <= 3x the price. The
-- thin-sale haircut is an in-place UPDATE, which the BEFORE INSERT floor never sees (Top Shot's 11-04 gap, fixed
-- there inside the two pinned haircut functions by 20261105044500). Here the same rule is enforced at the table,
-- so neither pinned haircut body is touched:
--   on an UPDATE OF fmv_usd that LOWERS an All Day price, the new price stops at least(best open offer, old price)
--   when that offer is above the cut and at most 3x it. It never raises a price. The suffix is appended once
--   ("_haircut_bidfloor", the Top Shot spelling).
-- The INSERT arm is unchanged in behaviour (it now also skips a second "_bidfloor").
-- Controls in prod (DO block, rolled back by RAISE): bid $16, row at $19.20 -> cut to $9.60 became $16.00
-- control_haircut_bidfloor; a second cut held at $16.00 with the suffix not doubled; a cut to $3.20 (bid 5x) went
-- through. Cosmetic edge: a row once stamped _bidfloor keeps the suffix if a later cut passes the 3x bound.
-- No data UPDATE was run; the 190 rows heal as they are re-priced.
-- anon-exec: fmv_snapshots_floor_allday_at_best_offer is NOT anon-executable (EXECUTE revoked).
-- Revert: remove trigger fmv_snapshots_hold_allday_cut_at_best_offer_trg, then re-apply the body from 20261112162628.
create or replace function public.fmv_snapshots_floor_allday_at_best_offer()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_allday constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_bid numeric;
begin
  if new.collection_id = c_allday
     and new.fmv_usd is not null and new.fmv_usd > 0
     and new.edition_id is not null
     and (tg_op = 'INSERT' or (old.fmv_usd is not null and new.fmv_usd < old.fmv_usd))
  then
    select max(o.amount) into v_bid
      from public.editions e
      join public.allday_open_offers o on o.edition_id = e.external_id
     where e.id = new.edition_id and e.collection_id = c_allday;
    if v_bid is not null and v_bid > new.fmv_usd and v_bid <= 3 * new.fmv_usd then
      if tg_op = 'INSERT' then
        new.fmv_usd := round(v_bid, 2);
      else
        new.fmv_usd := round(least(v_bid, old.fmv_usd), 2);
      end if;
      if coalesce(new.algo_version, '') !~ '_bidfloor$' then
        new.algo_version := coalesce(new.algo_version, '') || '_bidfloor';
      end if;
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public.fmv_snapshots_floor_allday_at_best_offer() from public, anon, authenticated;

create trigger fmv_snapshots_hold_allday_cut_at_best_offer_trg
  before update of fmv_usd on public.fmv_snapshots
  for each row execute function public.fmv_snapshots_floor_allday_at_best_offer();
