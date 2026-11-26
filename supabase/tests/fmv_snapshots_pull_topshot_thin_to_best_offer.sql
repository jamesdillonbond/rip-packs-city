-- DB invariant: public.fmv_snapshots_pull_topshot_thin_to_best_offer() — the Top Shot offer pull (step 1) and the
-- never-sold comparables hold (step 2) BEFORE INSERT trigger. Pinned 2026-11-13 when step 2 learned to say an offer
-- stopped its cut. What must hold:
--   1. never-sold ASK_ONLY, ask $100, estimate $2, offer $8 (under 10 % of the ask, so no pull) -> $8, _compcap_bidfloor
--      (NOT _bidpull: the price sits AT the offer, it is not "between offer and ask");
--   2. never-sold ASK_ONLY, ask $90, estimate $8, offer $30: the pull ($39.48, _bidpull) then the hold stops at the
--      offer -> $30, _bidpull_compcap_bidfloor;
--   3. never-sold, no offer -> the estimate, _compcap; an offer under the estimate does not raise it;
--   4. an edition that HAS sold: the pull only -> $39.48, _bidpull;
--   5. scope: an All Day row is untouched; a stale (> 3 d) estimate is ignored.
--   6. (2026-11-13 night) a LOW (sales-based) price is pulled only by an offer ≥ 25 % of it: $125 with a $21 offer
--      stays $125 (was $32.80); $125 with a $40 offer is pulled ($53.18); an ASK_ONLY $125 with a $21 offer is
--      still pulled ($32.80) -- the ask-only band kept the pull on the backtest.
--   7. (2026-11-26) on a LOW price an offer under HALF of it: a Legendary / Ultimate edition is not pulled at all
--      ($125 with a $40 offer stays $125, untagged -- holders accepted 0.7 % of such offers); every other tier is
--      pulled no lower than half ($125 with $40 -> $62.50, was $53.18). From half up nothing changed, any tier
--      ($60 with $40 -> $44.27).
--   9. (2026-11-26 afternoon) the Legendary / Ultimate skip also holds on an ASK_ONLY price while the edition has
--      a market sale inside 365 days ($125 with a $40 offer stays $125, untagged) -- the engine re-labels a listed
--      edition ASK_ONLY 30 days after its last sale and the skip used to lapse there. Last sale older than 365
--      days, or never sold: still pulled ($53.18).
--   8. (2026-11-26) every price the pull step acted on or skipped leaves one public.fmv_offer_pull_log row with
--      the PRE-pull price, the offer and the outcome ('pulled' | 'floored' | 'skipped'); a price the step never
--      considered leaves none; and a log write that fails does not fail the price.
-- The function DDL is VERBATIM from
-- supabase/migrations/20261126221042_audit_20261126_topshot_offer_pull_legendary_skip_covers_ask_only.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.offers (
  collection_id uuid, edition_id uuid, offer_amount_usd numeric, status text, offer_type text, expires_at timestamptz
);
CREATE TABLE public.sales_market (edition_id uuid, sold_at timestamptz DEFAULT now());
CREATE TABLE public.editions (id uuid, tier text);
CREATE TABLE public.fmv_comparable_estimates (
  edition_id uuid, baseline_kind text, n_set integer, est_usd numeric, computed_at timestamptz
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

-- >>> BEGIN verbatim fmv_snapshots_pull_topshot_thin_to_best_offer >>>
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
    -- ASK_ONLY price while the edition has a market sale inside 365 days. The engine re-labels a listed
    -- edition ASK_ONLY 30 days after its last sale, so the skip used to lapse on day 30 and the price fell
    -- back to the offer (Clingan Rookie Revelation: $96 -> $37 with no new sale and no new offer).
    if v_bid is not null and v_bid > 0 and v_bid < new.fmv_usd
       and v_bid >= (case when new.confidence = 'LOW' then 0.25 else 0.10 end) * new.fmv_usd then
      v_pre := new.fmv_usd;
      select e.tier::text into v_tier from public.editions e where e.id = new.edition_id;
      if v_tier in ('LEGENDARY', 'ULTIMATE') and v_bid < 0.5 * new.fmv_usd
         and (new.confidence = 'LOW'
              or exists (select 1 from public.sales_market s
                          where s.edition_id = new.edition_id
                            and s.sold_at > now() - interval '365 days'))
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
-- <<< END verbatim fmv_snapshots_pull_topshot_thin_to_best_offer <<<

CREATE TRIGGER fmv_snapshots_pull_topshot_thin_to_best_offer_trg
  BEFORE INSERT ON public.fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fmv_snapshots_pull_topshot_thin_to_best_offer();

-- editions: b1 (case 1) · b2 (case 2) · b3 no offer · b4 offer under estimate · b5 has sold · b6 All Day · b7 stale estimate
INSERT INTO public.fmv_comparable_estimates VALUES
  ('b0000000-0000-0000-0000-000000000001', 'set', 5, 2.00, now()),
  ('b0000000-0000-0000-0000-000000000002', 'set', 5, 8.00, now()),
  ('b0000000-0000-0000-0000-000000000003', 'set', 5, 8.00, now()),
  ('b0000000-0000-0000-0000-000000000004', 'set', 5, 8.00, now()),
  ('b0000000-0000-0000-0000-000000000005', 'set', 5, 8.00, now()),
  ('b0000000-0000-0000-0000-000000000006', 'set', 5, 8.00, now()),
  ('b0000000-0000-0000-0000-000000000007', 'set', 5, 8.00, now() - interval '5 days');

INSERT INTO public.offers VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-000000000001', 8.00, 'open', 'edition', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-000000000002', 30.00, 'open', 'edition', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-000000000002', 50.00, 'closed', 'edition', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-000000000004', 5.00, 'open', 'edition', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-000000000005', 30.00, 'open', 'edition', NULL),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'b0000000-0000-0000-0000-000000000006', 30.00, 'open', 'edition', NULL);

INSERT INTO public.sales_market VALUES ('b0000000-0000-0000-0000-000000000005'),
  ('b0000000-0000-0000-0000-000000000008'), ('b0000000-0000-0000-0000-000000000009'), ('b0000000-0000-0000-0000-00000000000a');
INSERT INTO public.offers VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-000000000008', 21.00, 'open', 'subedition', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-000000000009', 40.00, 'open', 'subedition', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-00000000000a', 21.00, 'open', 'subedition', NULL);

-- 2026-11-26 (case 7): b9 is a RARE; bb / bf Legendary / Ultimate with an offer under half; bc Legendary and be Rare
-- with an offer over half; bd a Legendary ask-only price that has sold.
INSERT INTO public.editions VALUES
  ('b0000000-0000-0000-0000-000000000009', 'RARE'),
  ('b0000000-0000-0000-0000-00000000000b', 'LEGENDARY'),
  ('b0000000-0000-0000-0000-00000000000c', 'LEGENDARY'),
  ('b0000000-0000-0000-0000-00000000000d', 'LEGENDARY'),
  ('b0000000-0000-0000-0000-00000000000e', 'RARE'),
  ('b0000000-0000-0000-0000-00000000000f', 'ULTIMATE');
INSERT INTO public.sales_market VALUES ('b0000000-0000-0000-0000-00000000000b'), ('b0000000-0000-0000-0000-00000000000c'),
  ('b0000000-0000-0000-0000-00000000000d'), ('b0000000-0000-0000-0000-00000000000e'), ('b0000000-0000-0000-0000-00000000000f');
INSERT INTO public.offers VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-00000000000b', 40.00, 'open', 'edition', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-00000000000c', 40.00, 'open', 'edition', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-00000000000d', 40.00, 'open', 'edition', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-00000000000e', 40.00, 'open', 'edition', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-00000000000f', 40.00, 'open', 'edition', NULL);

INSERT INTO public.editions VALUES
  ('b0000000-0000-0000-0000-0000000000c1', 'LEGENDARY'), ('b0000000-0000-0000-0000-0000000000c2', 'ULTIMATE');
INSERT INTO public.sales_market VALUES ('b0000000-0000-0000-0000-0000000000c1', now() - interval '400 days');
INSERT INTO public.offers VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-0000000000c1', 40.00, 'open', 'edition', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-0000000000c2', 40.00, 'open', 'edition', NULL);

INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, fmv_usd, algo_version) VALUES
  ('b0000000-0000-0000-0000-00000000000b', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LOW', 125, 'x'),
  ('b0000000-0000-0000-0000-00000000000c', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LOW', 60, 'x'),
  ('b0000000-0000-0000-0000-00000000000d', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 125, 'x'),
  ('b0000000-0000-0000-0000-00000000000e', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LOW', 60, 'x'),
  ('b0000000-0000-0000-0000-00000000000f', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LOW', 125, 'x'),
  ('b0000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 100, 'x'),
  ('b0000000-0000-0000-0000-000000000002', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x'),
  ('b0000000-0000-0000-0000-000000000003', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x'),
  ('b0000000-0000-0000-0000-000000000004', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x'),
  ('b0000000-0000-0000-0000-000000000005', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x'),
  ('b0000000-0000-0000-0000-000000000006', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 90, 'x'),
  ('b0000000-0000-0000-0000-000000000007', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x'),
  ('b0000000-0000-0000-0000-000000000008', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LOW', 125, 'x'),
  ('b0000000-0000-0000-0000-000000000009', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LOW', 125, 'x'),
  ('b0000000-0000-0000-0000-00000000000a', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 125, 'x'),
  ('b0000000-0000-0000-0000-0000000000c1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 125, 'x'),
  ('b0000000-0000-0000-0000-0000000000c2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 125, 'x');

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-000000000001';
  PERFORM _assert_eq(r.fmv_usd::text, '8.00', 'the hold stops at the offer');
  PERFORM _assert_eq(r.algo_version, 'x_compcap_bidfloor', 'and says the comparables cut was stopped by the offer, not _bidpull');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-000000000002';
  PERFORM _assert_eq(r.fmv_usd::text, '30.00', 'pull, then the hold, stopped at the open offer (the closed $50 is ignored)');
  PERFORM _assert_eq(r.algo_version, 'x_bidpull_compcap_bidfloor', 'both steps named, in order');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-000000000003';
  PERFORM _assert_eq(r.fmv_usd::text, '8.00', 'no offer: the comparable estimate');
  PERFORM _assert_eq(r.algo_version, 'x_compcap', 'tagged _compcap');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-000000000004';
  PERFORM _assert_eq(r.fmv_usd::text, '8.00', 'an offer under the estimate does not raise the hold');
  PERFORM _assert_eq(r.algo_version, 'x_compcap', 'still _compcap');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-000000000005';
  PERFORM _assert_eq(r.fmv_usd::text, '39.48', 'an edition that has sold: the offer pull only');
  PERFORM _assert_eq(r.algo_version, 'x_bidpull', 'tagged _bidpull');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-000000000006';
  PERFORM _assert_eq(r.fmv_usd::text, '90', 'an All Day row is out of scope');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-000000000007';
  PERFORM _assert_eq(r.fmv_usd::text, '90', 'an estimate older than 3 days is ignored (and no offer: no pull)');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-000000000008';
  PERFORM _assert_eq(r.fmv_usd::text, '125', 'a sales-based price is not dragged to an offer under 25 % of it (the Duncan ::23 case)');
  PERFORM _assert_eq(r.algo_version, 'x', 'and is not tagged _bidpull');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-000000000009';
  PERFORM _assert_eq(r.fmv_usd::text, '62.50', 'a sales-based price IS pulled by an offer at 32 % of it, but no lower than half (2026-11-26; was 53.18)');
  PERFORM _assert_eq(r.algo_version, 'x_bidpull', 'tagged _bidpull');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-00000000000a';
  PERFORM _assert_eq(r.fmv_usd::text, '32.80', 'an ask-only price is still pulled by an offer at 17 % of it');
  PERFORM _assert_eq(r.algo_version, 'x_bidpull', 'tagged _bidpull');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-00000000000b';
  PERFORM _assert_eq(r.fmv_usd::text, '125', 'a Legendary sales-based price ignores an offer under half of it (the Clingan Rookie Revelation case)');
  PERFORM _assert_eq(r.algo_version, 'x', 'and is not tagged _bidpull');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-00000000000f';
  PERFORM _assert_eq(r.fmv_usd::text, '125', 'an Ultimate one too');
  PERFORM _assert_eq(r.algo_version, 'x', 'untagged');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-00000000000c';
  PERFORM _assert_eq(r.fmv_usd::text, '44.27', 'a Legendary sales-based price IS pulled by an offer at 67 % of it');
  PERFORM _assert_eq(r.algo_version, 'x_bidpull', 'tagged _bidpull');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-00000000000e';
  PERFORM _assert_eq(r.fmv_usd::text, '44.27', 'above half the floor changes nothing for another tier');
  PERFORM _assert_eq(r.algo_version, 'x_bidpull', 'tagged _bidpull');
  -- case 9: bd sold inside 365 days; c1 last sold 400 days ago; c2 never sold (no estimate).
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-00000000000d';
  PERFORM _assert_eq(r.fmv_usd::text, '125', 'a Legendary ASK-ONLY price with a sale inside 365 days ignores an offer under half of it (the day-30 relabel)');
  PERFORM _assert_eq(r.algo_version, 'x', 'and is not tagged _bidpull');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-0000000000c1';
  PERFORM _assert_eq(r.fmv_usd::text, '53.18', 'a Legendary ASK-ONLY price whose last sale is over 365 days old is still pulled');
  PERFORM _assert_eq(r.algo_version, 'x_bidpull', 'tagged _bidpull');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-0000000000c2';
  PERFORM _assert_eq(r.fmv_usd::text, '53.18', 'a Legendary ASK-ONLY price that has never sold is still pulled');
  PERFORM _assert_eq(r.algo_version, 'x_bidpull', 'tagged _bidpull');

  -- case 8: the log. b2 b5 ba bc be c1 c2 pulled, b9 floored, bb bd bf skipped; b1 (offer under the gate) and b8 leave none.
  PERFORM _assert_eq((SELECT count(*)::text FROM public.fmv_offer_pull_log), '11', 'one log row per price the step acted on or skipped');
  PERFORM _assert_eq((SELECT string_agg(outcome || ':' || n, ' ' ORDER BY outcome) FROM (SELECT outcome, count(*) n FROM public.fmv_offer_pull_log GROUP BY 1) z),
    'floored:1 pulled:7 skipped:3', 'outcomes');
  PERFORM _assert_eq((SELECT pre_fmv_usd || '|' || bid_usd || '|' || fmv_usd || '|' || tier FROM public.fmv_offer_pull_log WHERE edition_id = 'b0000000-0000-0000-0000-000000000009'),
    '125|40.00|62.50|RARE', 'a floored row keeps the PRE-pull price (it cannot be rebuilt from the published one)');
  PERFORM _assert_eq((SELECT outcome || '|' || pre_fmv_usd || '|' || fmv_usd FROM public.fmv_offer_pull_log WHERE edition_id = 'b0000000-0000-0000-0000-00000000000b'),
    'skipped|125|125', 'a skipped Legendary row is recorded (it carries no suffix to find it by)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.fmv_offer_pull_log WHERE edition_id IN ('b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000008')),
    '0', 'a price the step never considered leaves no row');
  PERFORM _assert_eq((SELECT pre_fmv_usd || '|' || fmv_usd FROM public.fmv_offer_pull_log WHERE edition_id = 'b0000000-0000-0000-0000-000000000002'),
    '90|39.48', 'the log holds the pull step''s own result, before the comparables hold');

  -- a log write that fails must not fail the price: break the log table, price one more row.
  ALTER TABLE public.fmv_offer_pull_log DROP COLUMN outcome;
  INSERT INTO public.offers VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b0000000-0000-0000-0000-000000000010', 40.00, 'open', 'edition', NULL);
  INSERT INTO public.sales_market VALUES ('b0000000-0000-0000-0000-000000000010');
  INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, fmv_usd, algo_version)
    VALUES ('b0000000-0000-0000-0000-000000000010', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LOW', 60, 'x');
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'b0000000-0000-0000-0000-000000000010';
  PERFORM _assert_eq(r.fmv_usd::text, '44.27', 'the price is still written and pulled when the log write fails');

  RAISE NOTICE '✓ fmv_snapshots_pull_topshot_thin_to_best_offer: a hold the offer stopped says so; a low offer does not sink a sold price; every step is logged';
END $$;

ROLLBACK;
