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
-- The function DDL is VERBATIM from
-- supabase/migrations/20261113233615_audit_20261113_topshot_comparables_cut_at_the_offer_says_so.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.offers (
  collection_id uuid, edition_id uuid, offer_amount_usd numeric, status text, offer_type text, expires_at timestamptz
);
CREATE TABLE public.sales_market (edition_id uuid);
CREATE TABLE public.fmv_comparable_estimates (
  edition_id uuid, baseline_kind text, n_set integer, est_usd numeric, computed_at timestamptz
);
CREATE TABLE public.fmv_snapshots (
  id serial PRIMARY KEY, edition_id uuid, collection_id uuid, confidence text, fmv_usd numeric, algo_version text
);

-- >>> BEGIN verbatim fmv_snapshots_pull_topshot_thin_to_best_offer >>>
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

INSERT INTO public.sales_market VALUES ('b0000000-0000-0000-0000-000000000005');

INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, fmv_usd, algo_version) VALUES
  ('b0000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 100, 'x'),
  ('b0000000-0000-0000-0000-000000000002', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x'),
  ('b0000000-0000-0000-0000-000000000003', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x'),
  ('b0000000-0000-0000-0000-000000000004', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x'),
  ('b0000000-0000-0000-0000-000000000005', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x'),
  ('b0000000-0000-0000-0000-000000000006', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 90, 'x'),
  ('b0000000-0000-0000-0000-000000000007', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x');

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

  RAISE NOTICE '✓ fmv_snapshots_pull_topshot_thin_to_best_offer: a hold the offer stopped says so';
END $$;

ROLLBACK;
