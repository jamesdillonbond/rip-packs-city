-- audit_20261127_panini_low_price_pulled_toward_best_offer — 2026-11-27 ~10:55 AM PT (Cowork cloud; the scheduled
-- "FMV offer-rule backtests: All Day and Panini" read, then Trevor, asked whether to apply: "Apply it, and build Panini too").
-- Read: Project doc claude/fmv-offer-rule-backtests-allday-panini-2026-11-27.md.
--
-- FINDING. A Panini card with under 100 copies, a sales-based LOW price and a standing offer BELOW that price mostly
-- sells nearer the offer: about half of such sales since 11-13 printed at exactly the best offer recorded the day
-- before (panini_best_offer_daily), and the published price ran 1.50x the sale.
-- Shape: panini_sales (Marketplace; serial #1 and the last serial excluded), the PUBLISHED price = the Panini row in
-- fmv_snapshots (after the live-ask ceiling; NOT panini_fmv_snapshots, which is the engine's price before it) in force
-- >= 1 day before the sale, no sale between that price and the scored sale, offer = panini_best_offer_daily for the PT
-- day before the sale, offer in [10 %, 100 %) of the price. THIS rule, half-price floor included:
--                       n    published: ratio  within +/-25  WAPE     with the rule: ratio  within +/-25  WAPE
--   11-13..11-17       100              1.50   34.0 %        0.54                    0.93   47.0 %        0.36
--   11-18..11-22       101              1.83   16.8 %        0.74                    1.14   57.4 %        0.41
--   11-23..11-27        27              1.47   25.9 %        0.62                    1.07   44.4 %        0.35
--   all                228              1.50   25.4 %        0.63                    1.11   51.3 %        0.37
--   The rule is closer on 162 sales, further on 65; the floor binds on 79 of the 228 (median offer = half the price).
--   Without the floor: 42.7 % within. Context, LOW/ASK_ONLY under 100 copies with NO offer (n 462): 39.2 % within.
-- OUT OF SCOPE, by measurement: ASK_ONLY (n 18: 27.8 -> 16.7 %, worse; and never-sold cards got their own rule this
-- morning, 20261127164214 / 20261127165742) · cards with 100+ copies (n 75, same direction, too thin) · MEDIUM / HIGH
-- under 100 copies (n 178: 28.1 -> 48.3 %, not asked; a follow-up read).
-- Caveats: Panini sales arrive ~2 days late, so the last window is incomplete; the offer is the best across the
-- edition's cards, not the sold card's own; with the rule about half the sales still land outside +/-25 %.
--
-- RULE. Panini, confidence LOW, mint_cap < 100, best per-card offer on the edition (panini_card_serials.best_offer_usd,
-- cards re-read in the last 7 days; idx_panini_serials_offer_edition) with 10 % <= offer / price < 1:
--   price := greatest(price^0.25 x offer^0.75, offer, 0.5 x price), suffix "_bidpull".
-- Only LOWERS a price, never below the offer and never below half of itself. Fails open (no offer, no cap -> untouched).
-- Every step is written to fmv_offer_pull_log (pulled | floored), which now holds three collections: join editions.
--
-- ORDER. The trigger name sorts after fmv_snapshots_cap_panini_low_to_live_ask_trg, so the pull acts on the ask-capped
-- price (what the backtest scored) and "_bidpull" is the last suffix (e.g. "panini-1.4.2_askcap_bidpull"). Readers are
-- suffix-keyed with (_|$) or keyed on "_bidpull$" (lib/fmv-basis.ts, get_edition_detail.basis_offer); nothing anchors
-- "_askcap$". Panini LOW rows carry no floor_price_usd, so the thin-sale haircut never touches them.
-- SIZE at write time: 1,800 of 23,256 current LOW prices on cards under 100 copies are in scope; summed they fall
-- from ~$32,800 to ~$18,700 as the bridge re-inserts them (median current row ~4 days old). No re-stamp.
-- anon-exec: revoked (fmv_snapshots_pull_panini_low_to_best_offer) — new function; EXECUTE revoked from PUBLIC, anon, authenticated below.
-- FALSIFIER: on Panini sales scored against a "_bidpull" price, within +/-25 % for the pulled price below the pre-pull
-- price (fmv_offer_pull_log.pre_fmv_usd) on two consecutive weekly reads of >= 50 sales each.
-- REVERT: DROP TRIGGER fmv_snapshots_pull_panini_low_to_best_offer_trg ON public.fmv_snapshots; rows revert as re-written.

CREATE OR REPLACE FUNCTION public.fmv_snapshots_pull_panini_low_to_best_offer()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_panini constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_ext text;
  v_cap integer;
  v_tier text;
  v_bid numeric;
  v_new numeric;
  v_pre numeric;
  v_outcome text;
begin
  if new.collection_id = c_panini
     and new.confidence = 'LOW'
     and new.fmv_usd is not null and new.fmv_usd > 0
     and new.edition_id is not null
  then
    select e.external_id into v_ext
      from public.editions e
     where e.id = new.edition_id and e.collection_id = c_panini;
    select pe.mint_cap, pe.tier::text into v_cap, v_tier
      from public.panini_editions pe
     where pe.external_id = v_ext and pe.collection_id = c_panini;
    -- cards with under 100 copies only: that is where the price misses, and the only band with a deciding sample.
    if v_cap is not null and v_cap > 0 and v_cap < 100 then
      -- the best per-card offer on the edition, cards re-read in the last 7 days: the value capture_panini_best_offers()
      -- records each morning, so the backtest's offer and the trigger's are the same number.
      select max(s.best_offer_usd) into v_bid
        from public.panini_card_serials s
       where s.edition_external_id = v_ext
         and s.best_offer_usd > 0
         and s.captured_at > now() - interval '7 days';
      if v_bid is not null and v_bid > 0 and v_bid < new.fmv_usd and v_bid >= 0.10 * new.fmv_usd then
        v_pre := new.fmv_usd;
        v_new := greatest(round(power(new.fmv_usd, 0.25) * power(v_bid, 0.75), 2), round(v_bid, 2), 0.01);
        v_outcome := 'pulled';
        if v_new < round(0.5 * new.fmv_usd, 2) then
          v_new := round(0.5 * new.fmv_usd, 2);
          v_outcome := 'floored';
        end if;
        if v_new < new.fmv_usd then
          new.fmv_usd := v_new;
          new.algo_version := coalesce(new.algo_version, '') || '_bidpull';
          -- record the step (public.fmv_offer_pull_log, shared with Top Shot and All Day). A failed log write must never fail the price.
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
  end if;
  return new;
end $fn$;

revoke all on function public.fmv_snapshots_pull_panini_low_to_best_offer() from public, anon, authenticated;

drop trigger if exists fmv_snapshots_pull_panini_low_to_best_offer_trg on public.fmv_snapshots;
create trigger fmv_snapshots_pull_panini_low_to_best_offer_trg
  before insert on public.fmv_snapshots
  for each row execute function public.fmv_snapshots_pull_panini_low_to_best_offer();
