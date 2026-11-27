-- DB invariant: public.fmv_snapshots_pull_allday_thin_to_best_offer() — the NFL All Day offer pull, BEFORE INSERT on
-- fmv_snapshots (2026-11-27). The Top Shot rule as it stands after 11-26, reading allday_open_offers. What must hold:
--   1. an ASK_ONLY price with an offer below it is pulled: $90 with $30 -> $39.48, _bidpull;
--   2. a LOW price needs an offer >= 25 % of it ($125 with $21 stays $125, untagged) and is never pulled below half
--      ($125 with $40 -> $62.50); an ASK_ONLY $125 with $21 is still pulled ($32.80); under 10 % nothing moves;
--   3. a Legendary / Ultimate ignores an offer under half its price when LOW, or ASK_ONLY with a sale inside 180 days
--      (stays $125, untagged); an offer from half up pulls any tier ($60 with $40 -> $44.27); a Legendary ASK_ONLY
--      price last sold over 180 days ago is pulled ($53.18);
--   4. scope: a Top Shot row is untouched; an offer AT or ABOVE the price is not this rule's (the offer floor's);
--      a MEDIUM price is untouched; the offer is read by the edition's external_id (another edition's offer is not used);
--   5. every price the step acted on or skipped leaves one fmv_offer_pull_log row with the PRE-pull price; a price it
--      never considered leaves none; a log write that fails does not fail the price.
-- The function DDL is VERBATIM from
-- supabase/migrations/20261127183000_audit_20261127_allday_thin_price_pulled_toward_best_offer.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.editions (id uuid, collection_id uuid, external_id text, tier text);
CREATE TABLE public.allday_open_offers (offer_id text, edition_id text, amount numeric, updated_at timestamptz DEFAULT now());
CREATE TABLE public.sales_market (edition_id uuid, sold_at timestamptz DEFAULT now());
CREATE TABLE public.fmv_snapshots (
  id serial PRIMARY KEY, edition_id uuid, collection_id uuid, confidence text, fmv_usd numeric, algo_version text,
  computed_at timestamptz DEFAULT now()
);
CREATE TABLE public.fmv_offer_pull_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, edition_id uuid NOT NULL, snapshot_computed_at timestamptz,
  confidence text NOT NULL, tier text, pre_fmv_usd numeric NOT NULL, bid_usd numeric NOT NULL, fmv_usd numeric NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('pulled', 'floored', 'skipped')), logged_at timestamptz NOT NULL DEFAULT now()
);

-- >>> BEGIN verbatim fmv_snapshots_pull_allday_thin_to_best_offer >>>
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
-- <<< END verbatim fmv_snapshots_pull_allday_thin_to_best_offer <<<

CREATE TRIGGER fmv_snapshots_pull_allday_thin_to_best_offer_trg
  BEFORE INSERT ON public.fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fmv_snapshots_pull_allday_thin_to_best_offer();

-- a1 ask-only pull · a2 LOW under the 25 % gate · a3 LOW floored at half · a4 ask-only at 17 % · a5 ask-only under 10 %
-- a6 Legendary LOW skip · a7 Ultimate LOW skip · a8 Legendary LOW offer over half · a9 Legendary ask-only, sold recently
-- aa Legendary ask-only, sold 200 d ago · ab Top Shot row · ac offer above the price · ad MEDIUM · ae no offer of its own
INSERT INTO public.editions VALUES
  ('a0000000-0000-0000-0000-000000000001', 'dee28451-5d62-409e-a1ad-a83f763ac070', '101', 'RARE'),
  ('a0000000-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070', '102', 'RARE'),
  ('a0000000-0000-0000-0000-000000000003', 'dee28451-5d62-409e-a1ad-a83f763ac070', '103', 'RARE'),
  ('a0000000-0000-0000-0000-000000000004', 'dee28451-5d62-409e-a1ad-a83f763ac070', '104', 'RARE'),
  ('a0000000-0000-0000-0000-000000000005', 'dee28451-5d62-409e-a1ad-a83f763ac070', '105', 'RARE'),
  ('a0000000-0000-0000-0000-000000000006', 'dee28451-5d62-409e-a1ad-a83f763ac070', '106', 'LEGENDARY'),
  ('a0000000-0000-0000-0000-000000000007', 'dee28451-5d62-409e-a1ad-a83f763ac070', '107', 'ULTIMATE'),
  ('a0000000-0000-0000-0000-000000000008', 'dee28451-5d62-409e-a1ad-a83f763ac070', '108', 'LEGENDARY'),
  ('a0000000-0000-0000-0000-000000000009', 'dee28451-5d62-409e-a1ad-a83f763ac070', '109', 'LEGENDARY'),
  ('a0000000-0000-0000-0000-00000000000a', 'dee28451-5d62-409e-a1ad-a83f763ac070', '110', 'LEGENDARY'),
  ('a0000000-0000-0000-0000-00000000000b', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '111', 'RARE'),
  ('a0000000-0000-0000-0000-00000000000c', 'dee28451-5d62-409e-a1ad-a83f763ac070', '112', 'RARE'),
  ('a0000000-0000-0000-0000-00000000000d', 'dee28451-5d62-409e-a1ad-a83f763ac070', '113', 'RARE'),
  ('a0000000-0000-0000-0000-00000000000e', 'dee28451-5d62-409e-a1ad-a83f763ac070', '114', 'RARE');
INSERT INTO public.allday_open_offers (offer_id, edition_id, amount) VALUES
  ('o1', '101', 30), ('o1b', '101', 12), ('o2', '102', 21), ('o3', '103', 40), ('o4', '104', 21), ('o5', '105', 9),
  ('o6', '106', 40), ('o7', '107', 40), ('o8', '108', 40), ('o9', '109', 40), ('oa', '110', 40), ('ob', '111', 30),
  ('oc', '112', 95), ('od', '113', 30);
INSERT INTO public.sales_market VALUES ('a0000000-0000-0000-0000-000000000009', now() - interval '20 days'),
  ('a0000000-0000-0000-0000-00000000000a', now() - interval '200 days');

INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, fmv_usd, algo_version) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 90, 'x'),
  ('a0000000-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'LOW', 125, 'x'),
  ('a0000000-0000-0000-0000-000000000003', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'LOW', 125, 'x'),
  ('a0000000-0000-0000-0000-000000000004', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 125, 'x'),
  ('a0000000-0000-0000-0000-000000000005', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 125, 'x'),
  ('a0000000-0000-0000-0000-000000000006', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'LOW', 125, 'x'),
  ('a0000000-0000-0000-0000-000000000007', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'LOW', 125, 'x'),
  ('a0000000-0000-0000-0000-000000000008', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'LOW', 60, 'x'),
  ('a0000000-0000-0000-0000-000000000009', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 125, 'x'),
  ('a0000000-0000-0000-0000-00000000000a', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 125, 'x'),
  ('a0000000-0000-0000-0000-00000000000b', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x'),
  ('a0000000-0000-0000-0000-00000000000c', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 90, 'x'),
  ('a0000000-0000-0000-0000-00000000000d', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'MEDIUM', 90, 'x'),
  ('a0000000-0000-0000-0000-00000000000e', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 90, 'x');

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000001';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '39.48|x_bidpull', 'an ask-only price is pulled toward the BEST open offer on its own edition, tagged _bidpull');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000002';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '125|x', 'a sales-based price is not dragged to an offer under 25 % of it, and is not tagged');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000003';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '62.50|x_bidpull', 'a sales-based price is never pulled below half of itself (53.18 without the floor)');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000004';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '32.80|x_bidpull', 'an ask-only price is pulled by an offer at 17 % of it');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000005';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '125|x', 'an offer under 10 % of an ask-only price is a lowball and is ignored');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000006';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '125|x', 'a Legendary sales-based price ignores an offer under half of it, untagged');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000007';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '125|x', 'an Ultimate one too');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000008';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '44.27|x_bidpull', 'a Legendary sales-based price IS pulled by an offer at 67 % of it');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000009';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '125|x', 'a Legendary ASK-ONLY price with a sale inside 180 days ignores an offer under half of it');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-00000000000a';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '53.18|x_bidpull', 'a Legendary ASK-ONLY price whose last sale is over 180 days old is still pulled');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-00000000000b';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '90|x', 'a Top Shot row is out of scope');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-00000000000c';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '90|x', 'an offer above the price belongs to the offer floor, not to this rule');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-00000000000d';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '90|x', 'a MEDIUM price is untouched');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-00000000000e';
  PERFORM _assert_eq(r.fmv_usd::text || '|' || r.algo_version, '90|x', 'an edition with no offer of its own is untouched (the offer of another edition is not read)');

  -- the log: a1 a4 a8 aa pulled, a3 floored, a6 a7 a9 skipped; a2 a5 ab ac ad ae leave none.
  PERFORM _assert_eq((SELECT string_agg(outcome || ':' || n, ' ' ORDER BY outcome) FROM (SELECT outcome, count(*) n FROM public.fmv_offer_pull_log GROUP BY 1) z),
    'floored:1 pulled:4 skipped:3', 'one log row per price the step acted on or skipped, and none for the rest');
  PERFORM _assert_eq((SELECT pre_fmv_usd || '|' || bid_usd || '|' || fmv_usd || '|' || tier FROM public.fmv_offer_pull_log WHERE edition_id = 'a0000000-0000-0000-0000-000000000003'),
    '125|40|62.50|RARE', 'a floored row keeps the PRE-pull price');
  PERFORM _assert_eq((SELECT outcome || '|' || pre_fmv_usd || '|' || fmv_usd FROM public.fmv_offer_pull_log WHERE edition_id = 'a0000000-0000-0000-0000-000000000006'),
    'skipped|125|125', 'a skipped Legendary row is recorded');

  -- a log write that fails must not fail the price.
  ALTER TABLE public.fmv_offer_pull_log DROP COLUMN outcome;
  INSERT INTO public.editions VALUES ('a0000000-0000-0000-0000-000000000010', 'dee28451-5d62-409e-a1ad-a83f763ac070', '116', 'RARE');
  INSERT INTO public.allday_open_offers (offer_id, edition_id, amount) VALUES ('of', '116', 40);
  INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, fmv_usd, algo_version)
    VALUES ('a0000000-0000-0000-0000-000000000010', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'LOW', 60, 'x');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000010';
  PERFORM _assert_eq(r.fmv_usd::text, '44.27', 'the price is still written and pulled when the log write fails');

  RAISE NOTICE '✓ fmv_snapshots_pull_allday_thin_to_best_offer: a thin All Day price is pulled toward a lower open offer, inside the Top Shot guardrails, and every step is logged';
END $$;

ROLLBACK;
