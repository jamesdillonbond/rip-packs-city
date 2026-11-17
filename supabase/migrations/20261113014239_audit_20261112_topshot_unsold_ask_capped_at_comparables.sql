-- audit_20261112_topshot_unsold_ask_capped_at_comparables — 2026-11-12 ~5:42 PM PT (Cowork cloud; Trevor 5:08 PM PT:
-- "Keep going and refining and enhancing this fmv engine, along with predictive fmv ... for every collection we support").
--
-- FINDING. A Top Shot edition that has NEVER sold is priced from its lowest ask, and its FIRST sale lands far below it —
-- even after the offer pull (20261113012028). The comparable-edition estimate (fmv_comparable_estimates: set-mates'
-- geometric-mean price x shrunk player premium) is the better predictor there. First sales, snapshot ASK_ONLY >= 1 day
-- before, set basis with >= 3 priced set-mates:
--                                    after the pull              min(that, estimate)
--   last 30 d   (n 94, 46 editions)  ratio 1.99  16.0 % within +/-25  WAPE 105  ->  1.10  24.5 %  67   (better on 81 % of the rows it changes)
--   120-d first-sale table (n 20)          1.43  30.0 %               187       ->  1.03  55.0 %  44   (Sep / Oct / Nov each better on WAPE or within-25)
-- The 11-12 morning verdict ("the comp cap is not a win on Top Shot") was measured over ALL ask-only rows, most of which
-- have sold before and are already held to their own sales; it still stands for those. This is the never-sold subset.
--
-- RULE (added as step 2 of fmv_snapshots_pull_topshot_thin_to_best_offer — one function, one bid read, explicit order):
-- Top Shot, ASK_ONLY, no row in sales_market for the edition, a set-basis estimate with n_set >= 3 computed in the last
-- 3 days:  price := least(price, greatest(estimate, best open bid)), suffix "_compcap" (after "_bidpull" when both ran).
-- Never below a standing bid; when the bid is what stops the cut the row ends "_bidpull" (it sits AT the offer), not
-- "_compcap" (re-applied ~6:00 PM PT with that labelling; the first body stamped _compcap on 1 such row). Fails open (no estimate / non-set basis / stale estimate -> untouched).
-- Readers: "_compcap" last -> get_edition_detail.basis_comparables and askCapFlag "comparables" ("held to comparables"),
-- the marker All Day's comp cap already uses; both regexes are $-anchored on _compcap so "_bidpull_compcap" matches.
-- Size at ship: 316 never-sold ask-only editions, 119 with a qualifying estimate, 104 where it binds (median cut 1.9x).
-- anon-exec: unchanged (fmv_snapshots_pull_topshot_thin_to_best_offer) — CREATE OR REPLACE keeps the existing ACL (revoked).
-- Revert: re-apply the function body in 20261113012028 (the pull alone).
-- Falsifier: on the next 50 first sales of capped editions, min(price, estimate) within +/-25 % below the uncapped price's.
create or replace function public.fmv_snapshots_pull_topshot_thin_to_best_offer()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_topshot constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_bid numeric;
  v_new numeric;
  v_est numeric;
begin
  if new.collection_id = c_topshot
     and new.confidence in ('ASK_ONLY', 'LOW')
     and new.fmv_usd is not null and new.fmv_usd > 0
     and new.edition_id is not null
  then
    select max(o.offer_amount_usd) into v_bid
      from public.offers o
     where o.collection_id = c_topshot
       and o.edition_id = new.edition_id
       and o.status = 'open'
       and o.offer_type in ('edition', 'subedition')
       and (o.expires_at is null or o.expires_at > now());
    -- (1) the offer pull
    if v_bid is not null and v_bid > 0 and v_bid < new.fmv_usd and v_bid >= 0.10 * new.fmv_usd then
      v_new := greatest(round(power(new.fmv_usd, 0.25) * power(v_bid, 0.75), 2), round(v_bid, 2), 0.01);
      if v_new < new.fmv_usd then
        new.fmv_usd := v_new;
        new.algo_version := coalesce(new.algo_version, '') || '_bidpull';
      end if;
    end if;
    -- (2) an ask-only price on an edition that has NEVER sold is held to its comparable estimate, never below the bid
    if new.confidence = 'ASK_ONLY'
       and not exists (select 1 from public.sales_market s where s.edition_id = new.edition_id)
    then
      select e.est_usd into v_est
        from public.fmv_comparable_estimates e
       where e.edition_id = new.edition_id
         and e.baseline_kind = 'set' and e.n_set >= 3
         and e.est_usd > 0
         and e.computed_at > now() - interval '3 days';
      if v_est is not null then
        v_new := greatest(round(v_est, 2), round(coalesce(v_bid, 0), 2), 0.01);
        if v_new < new.fmv_usd then
          new.fmv_usd := v_new;
          -- the estimate set the number -> _compcap; the standing bid stopped it first -> the price is AT the offer
          if v_new > round(coalesce(v_bid, 0), 2) then
            new.algo_version := coalesce(new.algo_version, '') || '_compcap';
          elsif coalesce(new.algo_version, '') !~ '_bidpull$' then
            new.algo_version := coalesce(new.algo_version, '') || '_bidpull';
          end if;
        end if;
      end if;
    end if;
  end if;
  return new;
end $fn$;
