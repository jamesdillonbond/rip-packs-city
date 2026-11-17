-- DB invariant: public.check_set_completion(text) → boolean — true iff a wallet
-- owns EVERY edition of at least one set (drives the set-completion badge/
-- challenge). Pins: a fully-owned multi-edition set → true; a partially-owned set
-- → false; a fully-owned single-edition set → true; owning nothing → false. A
-- miscount either side would grant or withhold a reward incorrectly.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802192000_audit_20260802_snapshot_check_set_completion.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  external_id text,
  set_id      uuid
);

CREATE TABLE wallet_moments_cache (
  wallet_address text,
  edition_key    text
);

-- >>> BEGIN verbatim check_set_completion (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.check_set_completion(p_wallet text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with owned as (
    select distinct e.set_id, e.external_id
    from wallet_moments_cache w
    join editions e on e.external_id = w.edition_key
    where w.wallet_address = p_wallet
      and e.set_id is not null
  ),
  owned_counts as (
    select set_id, count(*)::int as owned_count
    from owned
    group by set_id
  ),
  set_totals as (
    select e.set_id, count(distinct e.external_id)::int as total
    from editions e
    where e.set_id in (select set_id from owned_counts)
    group by e.set_id
  )
  select exists(
    select 1
    from owned_counts o
    join set_totals s on s.set_id = o.set_id
    where s.total > 0 and o.owned_count >= s.total
  );
$function$;
-- <<< END verbatim check_set_completion <<<

-- Set S1 has 2 editions (A,B); set S2 has 1 edition (C).
INSERT INTO editions (external_id, set_id) VALUES
  ('A', '00000000-0000-0000-0000-000000000001'),
  ('B', '00000000-0000-0000-0000-000000000001'),
  ('C', '00000000-0000-0000-0000-000000000002');

-- W owns A+B → completes S1.
INSERT INTO wallet_moments_cache (wallet_address, edition_key) VALUES ('W','A'),('W','B');
SELECT _assert_eq(check_set_completion('W')::text, 'true', 'owns every edition of S1 → complete');

-- W2 owns A only → S1 incomplete, no other set owned → false.
INSERT INTO wallet_moments_cache (wallet_address, edition_key) VALUES ('W2','A');
SELECT _assert_eq(check_set_completion('W2')::text, 'false', 'partial set ownership → not complete');

-- W3 owns C → completes single-edition S2.
INSERT INTO wallet_moments_cache (wallet_address, edition_key) VALUES ('W3','C');
SELECT _assert_eq(check_set_completion('W3')::text, 'true', 'owns the only edition of S2 → complete');

-- W4 owns nothing → false.
SELECT _assert_eq(check_set_completion('W4')::text, 'false', 'owns nothing → not complete');

-- Duplicate wmc rows do not inflate owned_count past the set total (DISTINCT guard):
-- W5 owns A twice but not B → still incomplete on S1.
INSERT INTO wallet_moments_cache (wallet_address, edition_key) VALUES ('W5','A'),('W5','A');
SELECT _assert_eq(check_set_completion('W5')::text, 'false', 'duplicate ownership of A does NOT fake-complete S1');

SELECT '✓ check_set_completion invariants pass' AS result;
ROLLBACK;
