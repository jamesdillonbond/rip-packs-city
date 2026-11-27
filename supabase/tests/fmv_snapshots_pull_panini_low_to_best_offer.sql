-- DB invariant: public.fmv_snapshots_pull_panini_low_to_best_offer() — the Panini offer pull, BEFORE INSERT on
-- fmv_snapshots (2026-11-27). What must hold:
--   1. a LOW price on a card with under 100 copies and a fresh per-card offer below it is pulled toward the edition's
--      BEST such offer: $60 with $40 (and a lower $12 on another card) -> $44.27, "_bidpull" appended after "_askcap";
--   2. never below half the price: $125 with $40 -> $62.50 (53.18 unfloored); $125 with $21 -> $62.50;
--      an offer under 10 % of the price is ignored;
--   3. scope: 100+ copies, ASK_ONLY, MEDIUM, another collection, an offer on a card not re-read in 7 days, an offer
--      at or above the price, and an edition with no offer are all untouched; 99 copies is in scope;
--   4. every price it moved leaves one fmv_offer_pull_log row with the PRE-pull price (pulled | floored), a price it
--      did not move leaves none, and a log write that fails does not fail the price.
-- The function DDL is VERBATIM from
-- supabase/migrations/20261127191500_audit_20261127_panini_low_price_pulled_toward_best_offer.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.editions (id uuid, collection_id uuid, external_id text);
CREATE TABLE public.panini_editions (external_id text, collection_id uuid, mint_cap integer, tier text);
CREATE TABLE public.panini_card_serials (
  sku text, edition_external_id text, best_offer_usd numeric, captured_at timestamptz DEFAULT now()
);
CREATE TABLE public.fmv_snapshots (
  id serial PRIMARY KEY, edition_id uuid, collection_id uuid, confidence text, fmv_usd numeric, algo_version text,
  computed_at timestamptz DEFAULT now()
);
CREATE TABLE public.fmv_offer_pull_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, edition_id uuid NOT NULL, snapshot_computed_at timestamptz,
  confidence text NOT NULL, tier text, pre_fmv_usd numeric NOT NULL, bid_usd numeric NOT NULL, fmv_usd numeric NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('pulled', 'floored', 'skipped')), logged_at timestamptz NOT NULL DEFAULT now()
);

-- >>> BEGIN verbatim fmv_snapshots_pull_panini_low_to_best_offer >>>
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
-- <<< END verbatim fmv_snapshots_pull_panini_low_to_best_offer <<<

CREATE TRIGGER fmv_snapshots_pull_panini_low_to_best_offer_trg
  BEFORE INSERT ON public.fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fmv_snapshots_pull_panini_low_to_best_offer();

-- c1 pull · c2 floored at half · c3 offer at 17 % · c4 offer under 10 % · c5 100 copies · c6 ASK_ONLY · c7 MEDIUM
-- c8 stale offer · c9 offer above the price · ca Top Shot row · cb no offer · cc 99 copies
INSERT INTO public.editions VALUES
  ('c0000000-0000-0000-0000-000000000001', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'p1'),
  ('c0000000-0000-0000-0000-000000000002', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'p2'),
  ('c0000000-0000-0000-0000-000000000003', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'p3'),
  ('c0000000-0000-0000-0000-000000000004', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'p4'),
  ('c0000000-0000-0000-0000-000000000005', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'p5'),
  ('c0000000-0000-0000-0000-000000000006', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'p6'),
  ('c0000000-0000-0000-0000-000000000007', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'p7'),
  ('c0000000-0000-0000-0000-000000000008', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'p8'),
  ('c0000000-0000-0000-0000-000000000009', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'p9'),
  ('c0000000-0000-0000-0000-00000000000a', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'pa'),
  ('c0000000-0000-0000-0000-00000000000b', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'pb'),
  ('c0000000-0000-0000-0000-00000000000c', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'pc');
INSERT INTO public.panini_editions VALUES
  ('p1', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 25, 'RARE'),
  ('p2', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 25, 'RARE'),
  ('p3', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 25, 'RARE'),
  ('p4', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 25, 'RARE'),
  ('p5', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 100, 'RARE'),
  ('p6', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 25, 'RARE'),
  ('p7', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 25, 'RARE'),
  ('p8', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 25, 'RARE'),
  ('p9', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 25, 'RARE'),
  ('pb', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 25, 'RARE'),
  ('pc', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 99, 'RARE');
INSERT INTO public.panini_card_serials (sku, edition_external_id, best_offer_usd, captured_at) VALUES
  ('p1__3_25', 'p1', 40, now()), ('p1__7_25', 'p1', 12, now()), ('p1__9_25', 'p1', 0, now()),
  ('p2__3_25', 'p2', 40, now()), ('p3__3_25', 'p3', 21, now()), ('p4__3_25', 'p4', 8, now()),
  ('p5__3_100', 'p5', 40, now()), ('p6__3_25', 'p6', 40, now()), ('p7__3_25', 'p7', 40, now()),
  ('p8__3_25', 'p8', 40, now() - interval '9 days'), ('p9__3_25', 'p9', 75, now()),
  ('pa__3_25', 'pa', 40, now()), ('pc__3_99', 'pc', 40, now());

INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, fmv_usd, algo_version) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'LOW', 60, 'panini-1.4.2_askcap'),
  ('c0000000-0000-0000-0000-000000000002', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'LOW', 125, 'panini-1.4.2_askcap'),
  ('c0000000-0000-0000-0000-000000000003', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'LOW', 125, 'panini-1.4.2_askcap'),
  ('c0000000-0000-0000-0000-000000000004', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'LOW', 90, 'panini-1.4.2_askcap'),
  ('c0000000-0000-0000-0000-000000000005', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'LOW', 60, 'panini-1.4.2_askcap'),
  ('c0000000-0000-0000-0000-000000000006', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'ASK_ONLY', 60, 'panini-1.4.2_askcap'),
  ('c0000000-0000-0000-0000-000000000007', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'MEDIUM', 60, 'panini-1.4.2_askcap'),
  ('c0000000-0000-0000-0000-000000000008', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'LOW', 60, 'panini-1.4.2_askcap'),
  ('c0000000-0000-0000-0000-000000000009', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'LOW', 60, 'panini-1.4.2_askcap'),
  ('c0000000-0000-0000-0000-00000000000a', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LOW', 60, 'panini-1.4.2_askcap'),
  ('c0000000-0000-0000-0000-00000000000b', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'LOW', 60, 'panini-1.4.2_askcap'),
  ('c0000000-0000-0000-0000-00000000000c', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'LOW', 60, 'panini-1.4.2_askcap');

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-000000000001';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '44.27|panini-1.4.2_askcap_bidpull', 'a LOW price on a card under 100 copies is pulled toward the BEST fresh offer on its own edition, tagged after _askcap');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-000000000002';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '62.50|panini-1.4.2_askcap_bidpull', 'the pull never goes below half the price (53.18 without the floor)');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-000000000003';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '62.50|panini-1.4.2_askcap_bidpull', 'an offer at 17 % of the price still pulls, to the half-price floor');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-000000000004';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '90|panini-1.4.2_askcap', 'an offer under 10 % of the price is a lowball and is ignored');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-000000000005';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '60|panini-1.4.2_askcap', 'a card with 100 copies is out of scope');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-000000000006';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '60|panini-1.4.2_askcap', 'an ASK_ONLY price is out of scope (it has its own rule)');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-000000000007';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '60|panini-1.4.2_askcap', 'a MEDIUM price is out of scope');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-000000000008';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '60|panini-1.4.2_askcap', 'an offer on a card last re-read more than 7 days ago is not used');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-000000000009';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '60|panini-1.4.2_askcap', 'an offer at or above the price moves nothing');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-00000000000a';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '60|panini-1.4.2_askcap', 'a Top Shot row is out of scope');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-00000000000b';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '60|panini-1.4.2_askcap', 'an edition with no offer of its own is untouched');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-00000000000c';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '44.27|panini-1.4.2_askcap_bidpull', 'a card with 99 copies is in scope');

  -- the log: c1 cc pulled, c2 c3 floored; nothing else leaves a row.
  PERFORM _assert_eq((SELECT string_agg(outcome || ':' || n, ' ' ORDER BY outcome) FROM (SELECT outcome, count(*) n FROM public.fmv_offer_pull_log GROUP BY 1) z),
    'floored:2 pulled:2', 'one log row per price the rule moved, and none for the rest');
  PERFORM _assert_eq((SELECT pre_fmv_usd || '|' || bid_usd || '|' || fmv_usd || '|' || confidence FROM public.fmv_offer_pull_log WHERE edition_id = 'c0000000-0000-0000-0000-000000000002'),
    '125|40|62.50|LOW', 'a floored row keeps the PRE-pull price');

  -- a log write that fails must not fail the price.
  ALTER TABLE public.fmv_offer_pull_log DROP COLUMN outcome;
  INSERT INTO public.editions VALUES ('c0000000-0000-0000-0000-000000000010', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'pz');
  INSERT INTO public.panini_editions VALUES ('pz', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 25, 'RARE');
  INSERT INTO public.panini_card_serials (sku, edition_external_id, best_offer_usd) VALUES ('pz__3_25', 'pz', 40);
  INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, fmv_usd, algo_version)
    VALUES ('c0000000-0000-0000-0000-000000000010', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'LOW', 60, 'x');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'c0000000-0000-0000-0000-000000000010';
  PERFORM _assert_eq(r.fmv_usd::text, '44.27', 'the price is still written and pulled when the log write fails');

  RAISE NOTICE '✓ fmv_snapshots_pull_panini_low_to_best_offer: a LOW Panini price under 100 copies is pulled toward a lower fresh offer, never below half, and every move is logged';
END $$;

ROLLBACK;
