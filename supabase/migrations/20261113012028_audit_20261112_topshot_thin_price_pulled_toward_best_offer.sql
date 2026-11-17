-- audit_20261112_topshot_thin_price_pulled_toward_best_offer — 2026-11-12 ~5:20 PM PT (Cowork cloud; Trevor 5:08 PM PT:
-- "Keep going and refining and enhancing this fmv engine, along with predictive fmv based upon logical trends that make
-- sense, for every collection we support"; decisions delegated 11-12).
--
-- FINDING. On a Top Shot edition with few or no sales, a standing offer BELOW the published price is where the edition
-- then sells: 57 % of the next sales on ASK_ONLY editions with such a bid print at EXACTLY the bid (the seller accepts
-- the offer). The published price (0.90 x lowest ask, or a one-or-two-sale median) ignores the bid when it is lower.
-- Shape: sales_market, serial > 25, snapshot in force >= 1 day before the sale, no sale between the snapshot and the
-- scored sale, bid = best open edition / subedition offer one day before the sale, bid in [10 %, 100 %) of the price.
--                         published                      price^0.25 x bid^0.75
--   ASK_ONLY 10-13..10-23 (n 189)  ratio 1.10  49.7 % within +/-25  WAPE 21   ->  0.90  50.8 %  16
--   ASK_ONLY 10-24..11-02 (n 230)        1.35  38.3 %               56        ->  1.08  68.3 %  21
--   ASK_ONLY 11-03..11-12 (n 308)        1.32  40.3 %               55        ->  1.05  60.4 %  31
--   LOW      10-13..10-23 (n 475)        1.04  51.6 %               30        ->  0.78  49.5 %  29
--   LOW      10-24..11-02 (n 534)        1.13  46.8 %               28        ->  1.01  58.6 %  26
--   LOW      11-03..11-12 (n 666)        1.25  38.9 %               58        ->  1.05  61.3 %  35
-- Weight 0.75 on the bid, not the 0.85 that scores best on the last 20 days: the earliest window (LOW, -2.1 points,
-- ratio 0.78) says the market does not always clear at the bid, and 0.75 is never worse on WAPE in any window.
-- The comparable-estimate cap (min(price, estimate)) was re-tested on the same rows and loses (ratio 0.90, 42.6 %).
--
-- RULE. Top Shot, confidence ASK_ONLY or LOW, best open unexpired edition / subedition offer on this edition with
-- 10 % <= bid / price < 1:  price := price^0.25 x bid^0.75, suffix "_bidpull". A bid under 10 % of the price is treated
-- as a lowball and ignored. The existing offer floor handles bid > price; the two are mutually exclusive.
-- Only LOWERS a price, never below the bid. Fails open (no bid -> untouched). STALE is out: no clean sample (n 6).
-- A row this moves no longer equals its floor_price_usd, so the post-insert thin-sale haircut skips it (no double cut).
-- A marketplace-hidden bid (#220) is HIGH, so it can only weaken the pull.
--
-- Order: trigger name sorts after every fmv_snapshots_cap_* and after fmv_snapshots_floor_topshot_at_best_offer_trg,
-- so "_bidpull" is always the LAST insert-time suffix. Readers: get_edition_detail.basis_offer and askCapFlag
-- ("offers") — an ASK_ONLY row it moved is no longer "from asks".
-- Size at ship: ASK_ONLY 2,304 of 3,796 current rows, LOW 1,696 of 3,445. No re-stamp: rows change as writers re-insert.
-- anon-exec: fmv_snapshots_pull_topshot_thin_to_best_offer is NOT anon-executable (EXECUTE revoked).
-- Revert: remove trigger fmv_snapshots_pull_topshot_thin_to_best_offer_trg on fmv_snapshots; rows revert as re-written.
-- Falsifier: fmv_sales_backtest('nba_top_shot', 7) ASK_ONLY within_25 below 39.6 (its 11-12 14-day value) or LOW below
-- 54.9 on two consecutive weekly reads.
create or replace function public.fmv_snapshots_pull_topshot_thin_to_best_offer()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_topshot constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_bid numeric;
  v_new numeric;
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
    if v_bid is not null and v_bid > 0 and v_bid < new.fmv_usd and v_bid >= 0.10 * new.fmv_usd then
      v_new := greatest(round(power(new.fmv_usd, 0.25) * power(v_bid, 0.75), 2), round(v_bid, 2), 0.01);
      if v_new < new.fmv_usd then
        new.fmv_usd := v_new;
        new.algo_version := coalesce(new.algo_version, '') || '_bidpull';
      end if;
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public.fmv_snapshots_pull_topshot_thin_to_best_offer() from public, anon, authenticated;
create trigger fmv_snapshots_pull_topshot_thin_to_best_offer_trg
  before insert on public.fmv_snapshots
  for each row execute function public.fmv_snapshots_pull_topshot_thin_to_best_offer();
