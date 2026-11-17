-- DB invariant: public.fmv_snapshots_cap_allday_thin_to_comparables() — the All Day `_compcap` BEFORE INSERT trigger.
-- Pinned 2026-11-13 when the cut learned to stop at the best open offer. What must hold:
--   1. the motivating case: ask $90, estimate $8, open offer $30 -> $30, suffix _compcap_bidfloor (NOT $8);
--   2. no offer -> the estimate, suffix _compcap (unchanged behaviour);
--   3. an offer under the estimate does not raise the cut: -> the estimate, _compcap;
--   4. an offer at/above the incoming price: this trigger leaves the row alone (the cap only lowers);
--   5. scope: a Top Shot row and an All Day LOW row are untouched; a stale (> 3 d) estimate is ignored.
-- The function DDL is VERBATIM from
-- supabase/migrations/20261113195740_audit_20261113_allday_comparables_cut_stops_at_the_best_offer.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.allday_open_offers (edition_id text, amount numeric);
CREATE TABLE public.fmv_comparable_estimates (
  edition_id uuid, baseline_kind text, n_set integer, est_usd numeric, computed_at timestamptz
);
CREATE TABLE public.fmv_snapshots (
  id serial PRIMARY KEY, edition_id uuid, collection_id uuid, confidence text, fmv_usd numeric, algo_version text
);

-- >>> BEGIN verbatim fmv_snapshots_cap_allday_thin_to_comparables >>>
CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_allday_thin_to_comparables()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_allday constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_est numeric;
  v_bid numeric;
  v_new numeric;
begin
  if new.collection_id = c_allday
     and new.confidence in ('ASK_ONLY', 'STALE')
     and new.fmv_usd is not null and new.fmv_usd > 0
     and new.edition_id is not null
  then
    select m.est_usd into v_est
      from public.fmv_comparable_estimates m
     where m.edition_id = new.edition_id
       and m.baseline_kind = 'set' and m.n_set >= 3
       and m.est_usd >= 0.01
       and m.computed_at > now() - interval '3 days';
    if v_est is not null and new.fmv_usd > v_est then
      -- 2026-11-13: never below a standing offer (Top Shot's step 2 rule). The later bid floor only lifts within 3x
      -- of the price it sees, so a 10x cut here would otherwise publish a price far under a live bid.
      select max(o.amount) into v_bid
        from public.editions e
        join public.allday_open_offers o on o.edition_id = e.external_id
       where e.id = new.edition_id and e.collection_id = c_allday;
      v_new := greatest(round(v_est, 2), round(coalesce(v_bid, 0), 2), 0.01);
      if v_new < new.fmv_usd then
        new.fmv_usd := v_new;
        if v_new > round(coalesce(v_bid, 0), 2) then
          new.algo_version := coalesce(new.algo_version, '') || '_compcap';
        else
          new.algo_version := coalesce(new.algo_version, '') || '_compcap_bidfloor';
        end if;
      end if;
    end if;
  end if;
  return new;
end $fn$;
-- <<< END verbatim fmv_snapshots_cap_allday_thin_to_comparables <<<

CREATE TRIGGER fmv_snapshots_cap_allday_a_comparables_trg
  BEFORE INSERT ON public.fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fmv_snapshots_cap_allday_thin_to_comparables();

INSERT INTO public.editions VALUES
  ('a0000000-0000-0000-0000-000000000001', 'dee28451-5d62-409e-a1ad-a83f763ac070', '101'),
  ('a0000000-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070', '102'),
  ('a0000000-0000-0000-0000-000000000003', 'dee28451-5d62-409e-a1ad-a83f763ac070', '103'),
  ('a0000000-0000-0000-0000-000000000004', 'dee28451-5d62-409e-a1ad-a83f763ac070', '104'),
  ('a0000000-0000-0000-0000-000000000005', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1'),
  ('a0000000-0000-0000-0000-000000000006', 'dee28451-5d62-409e-a1ad-a83f763ac070', '106'),
  ('a0000000-0000-0000-0000-000000000007', 'dee28451-5d62-409e-a1ad-a83f763ac070', '107');

INSERT INTO public.fmv_comparable_estimates
SELECT id, 'set', 5, 8.00, now() FROM public.editions;
UPDATE public.fmv_comparable_estimates SET computed_at = now() - interval '5 days'
 WHERE edition_id = 'a0000000-0000-0000-0000-000000000007';

INSERT INTO public.allday_open_offers VALUES
  ('101', 30.00), ('101', 12.00),   -- (1) best offer 30, above the estimate
  ('103', 5.00),                    -- (3) offer under the estimate
  ('104', 120.00),                  -- (4) offer above the incoming price
  ('106', 30.00);                   -- (5) LOW row: out of scope even with an offer

INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, fmv_usd, algo_version) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 90, 'x'),
  ('a0000000-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 90, 'x'),
  ('a0000000-0000-0000-0000-000000000003', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'STALE',    90, 'x'),
  ('a0000000-0000-0000-0000-000000000004', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 90, 'x'),
  ('a0000000-0000-0000-0000-000000000005', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ASK_ONLY', 90, 'x'),
  ('a0000000-0000-0000-0000-000000000006', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'LOW',      90, 'x'),
  ('a0000000-0000-0000-0000-000000000007', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'ASK_ONLY', 90, 'x');

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000001';
  PERFORM _assert_eq(r.fmv_usd::text, '30.00', 'the cut stops at the best open offer, never below it');
  PERFORM _assert_eq(r.algo_version, 'x_compcap_bidfloor', 'and says the offer stopped it');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000002';
  PERFORM _assert_eq(r.fmv_usd::text, '8.00', 'no offer: the comparable estimate, as before');
  PERFORM _assert_eq(r.algo_version, 'x_compcap', 'tagged _compcap');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000003';
  PERFORM _assert_eq(r.fmv_usd::text, '8.00', 'an offer under the estimate does not raise the cut');
  PERFORM _assert_eq(r.algo_version, 'x_compcap', 'still _compcap');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000004';
  PERFORM _assert_eq(r.fmv_usd::text, '90', 'an offer above the incoming price: the cap leaves the row alone');
  PERFORM _assert_eq(r.algo_version, 'x', 'untagged');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000005';
  PERFORM _assert_eq(r.fmv_usd::text, '90', 'a Top Shot row is out of scope');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000006';
  PERFORM _assert_eq(r.fmv_usd::text, '90', 'an All Day LOW row is out of scope');

  SELECT * INTO r FROM public.fmv_snapshots WHERE edition_id = 'a0000000-0000-0000-0000-000000000007';
  PERFORM _assert_eq(r.fmv_usd::text, '90', 'an estimate older than 3 days is ignored');

  RAISE NOTICE '✓ fmv_snapshots_cap_allday_thin_to_comparables: the cut stops at the best offer';
END $$;

ROLLBACK;
