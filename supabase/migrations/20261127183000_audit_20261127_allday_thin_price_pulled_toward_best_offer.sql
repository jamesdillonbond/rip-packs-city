-- audit_20261127_allday_thin_price_pulled_toward_best_offer — 2026-11-27 ~10:35 AM PT (Cowork cloud; the scheduled
-- "FMV offer-rule backtests: All Day and Panini" read, then Trevor, asked whether to apply it: "Apply it, and build Panini too").
-- Read: Project doc claude/fmv-offer-rule-backtests-allday-panini-2026-11-27.md.
--
-- FINDING. On a thin NFL All Day edition (ASK_ONLY or LOW) with a standing offer BELOW the published price, the next
-- sale lands at the offer: 170 of 225 such sales since 11-13 printed at exactly the offer recorded the day before
-- (allday_best_offer_daily). The published price ran 1.50x the sale.
-- Shape: sales_market, serial > 25, price in force >= 1 day before the sale, no sale between that price and the scored
-- sale, offer = allday_best_offer_daily for the PT day before the sale. THIS rule (gates, half floor, Legendary skip)
-- applied to the price BEFORE the thin-sale haircut, since a pulled row leaves its ask floor and is not haircut:
--                       n    published: ratio  within +/-25  WAPE     with the rule: ratio  within +/-25  WAPE
--   11-13..11-17        93              1.67   19.4 %        1.02                    1.14   64.5 %        0.73
--   11-18..11-22       107              1.50   25.2 %        0.55                    1.11   74.8 %        0.21
--   11-23..11-27        23              1.09   43.5 %        0.18                    0.82   56.5 %        0.47
--   all                223              1.50   24.7 %        0.61                    1.11   68.6 %        0.51
--   LOW 131: 31.3 -> 69.5 %, WAPE 0.49 -> 0.27 · ASK_ONLY 92: 15.2 -> 67.4 %, WAPE 0.67 -> 0.64 (8 Legendary skipped).
--   The rule is closer on 175 sales, further on 40. Control (thin, no offer below the price, n 813): 52.8 % within.
-- The last window is 23 sales and there the pulled price sat ~18 % under the sale with a worse WAPE: that is the case
-- the falsifier watches (Top Shot showed the same on 11-16..11-18 and recovered).
--
-- RULE. All Day, ASK_ONLY or LOW, best open offer on the edition (allday_open_offers, the source the offer floor and
-- the haircut already read) below the price: price := greatest(price^0.25 x offer^0.75, offer), suffix "_bidpull".
-- Gates and guardrails are the Top Shot body's (20261126231111): LOW needs an offer >= 25 % of the price and is never
-- pulled below half of it; ASK_ONLY needs >= 10 %; a Legendary / Ultimate ignores an offer under half its price when
-- LOW, or ASK_ONLY with a market sale inside 180 days. Only LOWERS a price, never below the offer. Fails open.
-- Every step is written to fmv_offer_pull_log (pulled | floored | skipped). That table now holds BOTH collections:
-- join editions on edition_id to split them.
--
-- ORDER. The trigger name sorts after every fmv_snapshots_cap_* and after fmv_snapshots_floor_allday_at_best_offer_trg
-- (offer > price; the two are mutually exclusive), so "_bidpull" is the last insert-time suffix. A row it moves no
-- longer equals floor_price_usd, so the thin-sale haircut (an UPDATE after the insert) skips it: no double cut.
-- Readers are suffix-keyed and collection-blind: get_edition_detail.basis_offer, lib/fmv-basis.ts ("offers").
-- No re-stamp: rows change as the writers re-insert.
-- anon-exec: revoked (fmv_snapshots_pull_allday_thin_to_best_offer) — new function; EXECUTE revoked from PUBLIC, anon, authenticated below.
-- FALSIFIER: on All Day sales scored against a "_bidpull" price (fmv_offer_pull_log gives the pre-pull price), within
-- +/-25 % for the pulled price below the pre-pull price on two consecutive weekly reads of >= 50 sales each.
-- REVERT: DROP TRIGGER fmv_snapshots_pull_allday_thin_to_best_offer_trg ON public.fmv_snapshots; rows revert as re-written.

CREATE OR REPLACE FUNCTION public.fmv_snapshots_pull_allday_thin_to_best_offer()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_allday constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_ext text;
  v_tier text;
  v_bid numeric;
  v_new numeric;
  v_pre numeric;
  v_outcome text;
begin
  if new.collection_id = c_allday
     and new.confidence in ('ASK_ONLY', 'LOW')
     and new.fmv_usd is not null and new.fmv_usd > 0
     and new.edition_id is not null
  then
    select e.external_id, e.tier::text into v_ext, v_tier
      from public.editions e
     where e.id = new.edition_id and e.collection_id = c_allday;
    select max(o.amount) into v_bid
      from public.allday_open_offers o
     where o.edition_id = v_ext;
    -- The Top Shot rule as it stands after 2026-11-26: a sales-based (LOW) price is pulled only by an offer at least
    -- 25 % of it and never below half of itself; an ask-only price keeps the 10 % gate; a Legendary / Ultimate
    -- ignores an offer under half its price when the price is sales-based, or ask-based with a market sale inside
    -- 180 days (Trevor's 11-26 call: a scarce Moment is not marked down for not selling).
    if v_bid is not null and v_bid > 0 and v_bid < new.fmv_usd
       and v_bid >= (case when new.confidence = 'LOW' then 0.25 else 0.10 end) * new.fmv_usd then
      v_pre := new.fmv_usd;
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
      -- record the step (public.fmv_offer_pull_log, shared with Top Shot). A failed log write must never fail the price.
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
  end if;
  return new;
end $fn$;

revoke all on function public.fmv_snapshots_pull_allday_thin_to_best_offer() from public, anon, authenticated;

drop trigger if exists fmv_snapshots_pull_allday_thin_to_best_offer_trg on public.fmv_snapshots;
create trigger fmv_snapshots_pull_allday_thin_to_best_offer_trg
  before insert on public.fmv_snapshots
  for each row execute function public.fmv_snapshots_pull_allday_thin_to_best_offer();
