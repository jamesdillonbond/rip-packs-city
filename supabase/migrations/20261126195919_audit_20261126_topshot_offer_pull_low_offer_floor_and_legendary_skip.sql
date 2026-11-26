-- audit_20261126_topshot_offer_pull_low_offer_floor_and_legendary_skip
-- Top Shot offer pull, sales-based (LOW) prices only. Approved by Trevor 2026-11-26 11:58 AM PT.
--   (a) Legendary / Ultimate: an offer under 50 % of the price does not pull at all.
--   (b) every other tier: the pulled price is never below 50 % of the price.
--   ASK_ONLY is unchanged.
-- Evidence (Project docs claude/fmv-offer-pull-low-bid-research-2026-11-26.md and
-- claude/fmv-offer-pull-collector-behavior-2026-11-26.md): Legendary holders accepted 16 of 2,408 top
-- offers placed under half the price (09-10 -> 11-11); 78 % of next Legendary sales after agreeing prior
-- sales landed at >= 75 % of them (n 330); median sale with a 25-40 % bid is 0.51 of the price (n 205).
-- Backtest, LOW, 10-01 -> 11-26, n 2,325: within +/-25 % 66.4 -> 67.1, WAPE 0.217 -> 0.209;
-- Legendary n 103: 74.8 -> 80.6, WAPE 0.178 -> 0.151.
-- Falsifier: Legendary LOW within +/-25 % under 74.8 on two consecutive weekly reads -> revert.
-- REVERT: re-apply the function body of 20261114132054 (prosrc md5 8bb48da06d98c05351f86f72d3c9ab9e).
-- anon-exec: unchanged (fmv_snapshots_pull_topshot_thin_to_best_offer) — CREATE OR REPLACE of an existing trigger fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false.
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fmv_snapshots_pull_topshot_thin_to_best_offer()'::regprocedure)
     <> '8bb48da06d98c05351f86f72d3c9ab9e' THEN
    RAISE EXCEPTION 'fmv_snapshots_pull_topshot_thin_to_best_offer changed since it was read 2026-11-26; re-read before replacing';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fmv_snapshots_pull_topshot_thin_to_best_offer()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_topshot constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_bid numeric;
  v_new numeric;
  v_est numeric;
  v_tier text;
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
    -- 2026-11-26: on a LOW price, (a) a Legendary / Ultimate edition ignores an offer under half the price
    -- (holders accepted 0.7 % of such offers), and (b) every other tier is never pulled below half the price
    -- (median sale with a 25-40 % bid = 0.51 of the price). ASK_ONLY unchanged.
    if v_bid is not null and v_bid > 0 and v_bid < new.fmv_usd
       and v_bid >= (case when new.confidence = 'LOW' then 0.25 else 0.10 end) * new.fmv_usd then
      if new.confidence = 'LOW' then
        select e.tier::text into v_tier from public.editions e where e.id = new.edition_id;
      end if;
      if new.confidence = 'LOW' and v_tier in ('LEGENDARY', 'ULTIMATE') and v_bid < 0.5 * new.fmv_usd then
        null;
      else
        v_new := greatest(round(power(new.fmv_usd, 0.25) * power(v_bid, 0.75), 2), round(v_bid, 2), 0.01);
        if new.confidence = 'LOW' then
          v_new := greatest(v_new, round(0.5 * new.fmv_usd, 2));
        end if;
        if v_new < new.fmv_usd then
          new.fmv_usd := v_new;
          new.algo_version := coalesce(new.algo_version, '') || '_bidpull';
        end if;
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