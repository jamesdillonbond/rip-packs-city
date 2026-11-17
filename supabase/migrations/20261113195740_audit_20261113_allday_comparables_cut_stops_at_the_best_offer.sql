-- audit_20261113_allday_comparables_cut_stops_at_the_best_offer
--
-- Claude Code cloud, 2026-11-13 ~11:55 AM PT. One change to fmv_snapshots_cap_allday_thin_to_comparables (the All
-- Day `_compcap` trigger, 20261112160558): the comparable-estimate cut never lands BELOW the edition's best open
-- offer — the same rule Top Shot's step 2 already carries (20261113014239: greatest(estimate, bid)).
--
-- WHAT WAS WRONG (found by an independent review of the 11-12 FMV commits, confirmed live). BEFORE INSERT triggers
-- fire in name order: `..._cap_allday_a_comparables_trg` cuts first, then `..._floor_allday_at_best_offer_trg` lifts
-- a price to the best offer only when that offer is <= 3x the price it SEES — the already-cut price. So an ASK_ONLY
-- edition at $90 with a comparable estimate of $8 and a $30 open offer published $8 ("held to comparables") while a
-- buyer stood at $30: the floor's 3x guard (meant to ignore an absurd bid against a sane price) was being applied to
-- a price the cap had just cut by 10x. Live 11-13 ~12:00 PM PT: 6 current All Day `_compcap` prices sit below a
-- standing offer, 4 of them by more than 3x ($106.11 of gap in total).
--
-- THE CHANGE. new price = greatest(round(estimate, 2), round(best open offer, 2)), applied only when it is below the
-- incoming price (the cap still only LOWERS). Suffix: `_compcap` when the estimate set it; `_compcap_bidfloor` when
-- the offer stopped it — the suffix get_edition_detail (`_compcap(_bidfloor)?$` -> basis_comparables) and
-- lib/fmv-basis.ts already read as "held to comparables, lifted to a live bid". The floor trigger then sees
-- bid = price and does nothing. Offer read = the floor trigger's own (allday_open_offers by external_id, scoped to
-- All Day). Rows with no offer behave exactly as before.
--
-- Base verified: live prosrc md5 b385a902836a29fc08730a461ff899af (= 20261112160558). The DO block refuses if moved.
-- anon-exec: unchanged (fmv_snapshots_cap_allday_thin_to_comparables) — CREATE OR REPLACE of an existing trigger fn; ACL preserved (revoked from public/anon/auth).
-- Caller: trigger fmv_snapshots_cap_allday_a_comparables_trg (BEFORE INSERT on fmv_snapshots) only.
-- Pin: supabase/tests/fmv_snapshots_cap_allday_thin_to_comparables.sql.
-- Takes effect on each edition's next snapshot (ASK_ONLY rows are re-written every few hours).
-- APPLIED 2026-11-13 ~11:57 AM PT (recorded 20261113195740); live prosrc md5 1f5822c0e91d92b73178955649c38f76 = this
-- file's body; anon EXECUTE still false.
--
-- REVERT: re-create the 20261112160558 body (the `if v_est is not null and new.fmv_usd > v_est` branch).

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fmv_snapshots_cap_allday_thin_to_comparables()'::regprocedure)
     <> 'b385a902836a29fc08730a461ff899af' THEN
    RAISE EXCEPTION 'fmv_snapshots_cap_allday_thin_to_comparables changed since it was read; re-derive this migration';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_allday_thin_to_comparables()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_allday constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_est numeric;
  v_bid numeric;
  v_new numeric;
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
      -- 2026-11-13: never below a standing offer (Top Shot's step 2 rule). The later bid floor only lifts within 3x
      -- of the price it sees, so a 10x cut here would otherwise publish a price far under a live bid.
      select max(o.amount) into v_bid
        from public.editions e
        join public.allday_open_offers o on o.edition_id = e.external_id
       where e.id = new.edition_id and e.collection_id = c_allday;
      v_new := greatest(round(v_est, 2), round(coalesce(v_bid, 0), 2), 0.01);
      if v_new < new.fmv_usd then
        new.fmv_usd := v_new;
        if v_new > round(coalesce(v_bid, 0), 2) then
          new.algo_version := coalesce(new.algo_version, '') || '_compcap';
        else
          new.algo_version := coalesce(new.algo_version, '') || '_compcap_bidfloor';
        end if;
      end if;
    end if;
  end if;
  return new;
end $fn$;
