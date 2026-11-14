-- audit_20261113_topshot_offer_pull_needs_a_real_offer_on_a_sold_price
--
-- fmv_snapshots_pull_topshot_thin_to_best_offer — step 1 (the offer pull, `_bidpull`): a LOW (sales-based)
-- Top Shot price is pulled toward the best open offer only when that offer is at least 25 % of the price.
-- ASK_ONLY keeps the 10 % floor. Step 2 (the never-sold comparables hold) is unchanged.
--
-- TRIGGER (Trevor, 2026-11-13 ~10:40 PM PT: "Yes do that", on why a pack's pull value and the binder's
-- wallet FMV disagreed). Tim Duncan — Run It Back: Origins, the 17-mint parallel (274:9083::23): two sales,
-- $299 (11-04) and $125 (11-09), best open offer $21 → FMV 125^0.25 × 21^0.75 = $32.80, a quarter of the
-- last sale. The 11-12 backtest that set the rule was right overall; this band (offer < 25 % of price) is
-- ~5 % of pulled rows and was not separated.
--
-- BACKTEST (production, 2026-11-13 night; sales_market Top Shot, 45 d; the LOW / ASK_ONLY snapshot in force
-- ≥ 1 day before the sale, not itself pulled, no sale between; the best open edition/subedition offer as of
-- one day before the sale; 10 % ≤ bid/price < 1; three 15-day windows):
--   offer < 25 % of price, LOW (n 12 / 17 / 9):  within ±25 % pulled 8.3 / 0.0 / 22.2 vs unpulled 16.7 / 29.4 / 22.2;
--                                               WAPE pulled 71.3 / 74.6 / 61.2 vs unpulled 30.3 / 40.9 / 66.4
--   offer < 25 % of price, ASK_ONLY (n 45/26/44): WAPE pulled 66.6 / 47.5 / 59.9 vs 80.9 / 219.3 / 181.1 → keep
--   offer ≥ 25 %, all sizes (n 3,195): the 0.75 pull is the best weight tested (within ±25 % 70.1 / 59.0 / 54.9
--   by circulation ≥100 / 26–99 / ≤25 vs 47.2 / 41.4 / 42.8 unpulled) → unchanged
-- Existing rows re-price as fmv-recalc re-inserts them (the hot lane picks up any newer sale within minutes).
--
-- Base: prosrc md5 ac896023e42b19be6fcfdcda7b64ea2e (= 20261113233615), asserted below.
-- anon-exec: unchanged (fmv_snapshots_pull_topshot_thin_to_best_offer) — CREATE OR REPLACE keeps the existing ACL (revoked).
-- Revert: re-apply the function body in 20261113233615.
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fmv_snapshots_pull_topshot_thin_to_best_offer()'::regprocedure)
     <> 'ac896023e42b19be6fcfdcda7b64ea2e' THEN
    RAISE EXCEPTION 'fmv_snapshots_pull_topshot_thin_to_best_offer changed since 20261113233615; re-read before replacing';
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
    -- (1) the offer pull. 2026-11-13 (night): a SALES-based (LOW) price is pulled only by an offer at
    -- least 25 % of it; an ask-only price keeps the 10 % floor. Backtest, 45 d of Top Shot sales, three
    -- 15-day windows: LOW with the bid under 25 % of the price, the pull scored within +/-25 % on 8.3 / 0.0 /
    -- 22.2 % of next sales vs 16.7 / 29.4 / 22.2 % unpulled, WAPE 71 / 75 / 61 vs 30 / 41 / 66 (n 38);
    -- ASK_ONLY in the same band the pull still cut WAPE in every window (81->67, 219->48, 181->60), so it stays.
    if v_bid is not null and v_bid > 0 and v_bid < new.fmv_usd
       and v_bid >= (case when new.confidence = 'LOW' then 0.25 else 0.10 end) * new.fmv_usd then
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
