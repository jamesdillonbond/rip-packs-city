-- DB invariant: public.get_linked_parents(text) + public.get_linked_children(text)
-- — the hybrid-custody account-linking reads. Each returns the ACTIVE linked
-- addresses (parents of a child / children of a parent), newest-first, COALESCEd
-- to an empty array so array callers never see NULL. Inactive links are excluded.
--
-- The two function DDLs below are VERBATIM copies of the committed migration
-- (supabase/migrations/20260801160500_audit_20260801_snapshot_get_linked_accounts.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if either drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE linked_accounts (
  parent_addr   text,
  child_addr    text,
  active        boolean,
  last_event_at timestamptz
);

-- >>> BEGIN verbatim get_linked_parents (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_linked_parents(addr text)
 RETURNS text[]
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(array_agg(parent_addr ORDER BY last_event_at DESC), ARRAY[]::TEXT[])
  FROM linked_accounts
  WHERE child_addr = addr AND active = TRUE;
$function$;
-- <<< END verbatim get_linked_parents <<<

-- >>> BEGIN verbatim get_linked_children (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_linked_children(addr text)
 RETURNS text[]
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(array_agg(child_addr ORDER BY last_event_at DESC), ARRAY[]::TEXT[])
  FROM linked_accounts
  WHERE parent_addr = addr AND active = TRUE;
$function$;
-- <<< END verbatim get_linked_children <<<

-- No links → empty array, never NULL (the COALESCE guard).
SELECT _assert(get_linked_parents('0xnobody') = ARRAY[]::text[], 'no parents → empty array not NULL');
SELECT _assert(get_linked_children('0xnobody') = ARRAY[]::text[], 'no children → empty array not NULL');

-- One parent P with two ACTIVE children (newest-first) and one INACTIVE child.
INSERT INTO linked_accounts VALUES
  ('0xP', '0xC1', TRUE,  '2026-01-01'),
  ('0xP', '0xC2', TRUE,  '2026-06-01'),
  ('0xP', '0xCold', FALSE, '2026-09-01');

-- children of P: active only, ordered newest last_event_at first → [C2, C1].
SELECT _assert_eq(get_linked_children('0xP')::text, '{0xC2,0xC1}', 'active children newest-first, inactive excluded');

-- parents of C1: exactly [P].
SELECT _assert_eq(get_linked_parents('0xC1')::text, '{0xP}', 'child → its active parent');

-- parents of Cold (the inactive link): empty (active = TRUE filter).
SELECT _assert(get_linked_parents('0xCold') = ARRAY[]::text[], 'inactive child link → no parent');

-- A child with two active parents resolves to both, newest-first.
INSERT INTO linked_accounts VALUES
  ('0xPa', '0xShared', TRUE, '2026-02-01'),
  ('0xPb', '0xShared', TRUE, '2026-08-01');
SELECT _assert_eq(get_linked_parents('0xShared')::text, '{0xPb,0xPa}', 'two active parents newest-first');

SELECT '✓ get_linked_parents/children invariants pass' AS result;
ROLLBACK;
