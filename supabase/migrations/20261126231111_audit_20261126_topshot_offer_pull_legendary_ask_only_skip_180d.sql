-- audit_20261126_topshot_offer_pull_legendary_ask_only_skip_180d — narrows 20261126221042's window from 365 to 180 days.
-- Trevor, 2026-11-26 ~3:15 PM PT, chose 180 days after this read (Legendary / Ultimate sales 09-08 -> 11-26,
-- serial > 10, an offer under half the pre-pull price standing, by age of the previous sale; within +/-25 % of
-- the sale, pulled vs not pulled): 31-90 d 39.5 vs 18.4 (n 76) · 91-180 d 39.7 vs 23.8 (n 63) ·
-- 181-365 d 45.5 vs 3.0 (n 33; the unpulled price ran about 2.7x the sale, WAPE 1.73 vs 0.30).
-- The 31-180-day cost is accepted on holder behavior (0.3-1.2 % of such offers are filled); the oldest band is not.
-- Pricing otherwise unchanged. The 98 re-stamped rows whose last sale is over 180 days old go back to the pulled
-- price in the companion migration.
-- REVERT: re-apply the function body of 20261126221042 (prosrc md5 5ce29e6c08abfbe8e8d78ec51ac5e36d).
-- anon-exec: unchanged (fmv_snapshots_pull_topshot_thin_to_best_offer) — CREATE OR REPLACE of an existing trigger fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false.
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fmv_snapshots_pull_topshot_thin_to_best_offer()'::regprocedure)
     <> '5ce29e6c08abfbe8e8d78ec51ac5e36d' THEN
    RAISE EXCEPTION 'fmv_snapshots_pull_topshot_thin_to_best_offer changed since 20261126221042; re-read before replacing';
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
  v_pre numeric;
  v_outcome text;
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
    -- 2026-11-26 (afternoon, Trevor: "we need to fix that"): the Legendary / Ultimate skip also covers an
    -- ASK_ONLY price while the edition has a market sale inside 180 days. The engine re-labels a listed
    -- edition ASK_ONLY 30 days after its last sale, so the skip used to lapse on day 30 and the price fell
    -- back to the offer (Clingan Rookie Revelation: $96 -> $37 with no new sale and no new offer).
    -- The window is 180 days (first shipped as 365; narrowed the same afternoon, Trevor's choice): unpulled prices
    -- scored 3 % within +/-25 % of the next sale vs 45 % pulled when the last sale was 181-365 days old (n 33).
    if v_bid is not null and v_bid > 0 and v_bid < new.fmv_usd
       and v_bid >= (case when new.confidence = 'LOW' then 0.25 else 0.10 end) * new.fmv_usd then
      v_pre := new.fmv_usd;
      select e.tier::text into v_tier from public.editions e where e.id = new.edition_id;
      if v_tier in ('LEGENDARY', 'ULTIMATE') and v_bid < 0.5 * new.fmv_usd
         and (new.confidence = 'LOW'
              or exists (select 1 from public.sales_market s
                          where s.edition_id = new.edition_id
                            and s.sold_at > now() - interval '180 days'))
      then
        v_outcome := 'skipped';
      else
        v_new := greatest(round(power(new.fmv_usd, 0.25) * power(v_bid, 0.75), 2), round(v_bid, 2), 0.01);
        v_outcome := 'pulled';
        if new.confidence = 'LOW' and v_new < round(0.5 * new.fmv_usd, 2) then
          v_new := round(0.5 * new.fmv_usd, 2);
          v_outcome := 'floored';
        end if;
        if v_new < new.fmv_usd then
          new.fmv_usd := v_new;
          new.algo_version := coalesce(new.algo_version, '') || '_bidpull';
        else
          v_outcome := null;
        end if;
      end if;
      -- 2026-11-26: record the step (see public.fmv_offer_pull_log). A failed log write must never fail the price.
      if v_outcome is not null then
        begin
          insert into public.fmv_offer_pull_log (edition_id, snapshot_computed_at, confidence, tier, pre_fmv_usd, bid_usd, fmv_usd, outcome)
          values (new.edition_id, new.computed_at, new.confidence::text, v_tier, v_pre, v_bid, new.fmv_usd, v_outcome);
        -- when-others-timeout-blind: intentional — a per-row trigger must not swallow a statement_timeout and run on unbounded.
        exception when others then
          null;
        end;
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