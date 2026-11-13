-- audit_20261113_topshot_comparables_cut_at_the_offer_says_so — 2026-11-13 ~3:55 PM PT (Claude Code cloud; Trevor:
-- "Keep going and do it all"; the cosmetic finding left by the 11-13 independent review of the 11-12 FMV commits).
--
-- FINDING. Step 2 of fmv_snapshots_pull_topshot_thin_to_best_offer holds a never-sold Top Shot ask-only price to its
-- comparable estimate, never below the best open offer. When the OFFER stops that cut the price sits AT the offer, but
-- the row was tagged "_bidpull", which every reader renders as "between offer and ask, weighted toward the offer"
-- (lib/fmv-basis.ts BETWEEN_OFFER_AND_ASK; get_edition_detail.basis_offer) — the wrong mechanism, and it hides that the
-- comparable estimate is why the price came down.
-- FIX. Tag that case "_compcap_bidfloor", All Day's suffix for the same case since 20261113195740: get_edition_detail
-- (basis_comparables ~ '_compcap(_bidfloor)?$') and askCapFlag read it as "held to comparables", and priceRuleNotes adds
-- "lifted to the best open offer". Price arithmetic unchanged; only the suffix of that one branch.
-- Base: prosrc md5 b8ddde5377cf1324c6ad045fb0a6e808 (= the body in 20261113014239), asserted below.
-- anon-exec: unchanged (fmv_snapshots_pull_topshot_thin_to_best_offer) — CREATE OR REPLACE keeps the existing ACL (revoked).
-- Revert: re-apply the function body in 20261113014239. Rows re-label as writers re-insert.
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fmv_snapshots_pull_topshot_thin_to_best_offer()'::regprocedure)
     <> 'b8ddde5377cf1324c6ad045fb0a6e808' THEN
    RAISE EXCEPTION 'fmv_snapshots_pull_topshot_thin_to_best_offer changed since 20261113014239; re-read before replacing';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fmv_snapshots_pull_topshot_thin_to_best_offer()
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
          -- the estimate set the number -> _compcap; the standing bid stopped it first -> the price is AT the offer:
          -- _compcap_bidfloor (2026-11-13; All Day's suffix for the same case), not _bidpull ("between the two").
          if v_new > round(coalesce(v_bid, 0), 2) then
            new.algo_version := coalesce(new.algo_version, '') || '_compcap';
          else
            new.algo_version := coalesce(new.algo_version, '') || '_compcap_bidfloor';
          end if;
        end if;
      end if;
    end if;
  end if;
  return new;
end $fn$;
