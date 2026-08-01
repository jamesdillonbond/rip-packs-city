-- DB invariant: public.resolve_canonical_owner(text) — canonical (parent) owner
-- resolution for hybrid-custody linked wallets. Used by analytics_sales_resolved
-- and every leaderboard that collapses a parent + its child wallets into one
-- actor; a wrong result either double-counts a whale across its child wallets or
-- attributes a child's activity to the wrong parent.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801160000_audit_20260801_snapshot_resolve_canonical_owner.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE linked_accounts (
  parent_addr   text,
  child_addr    text,
  active        boolean,
  last_event_at timestamptz
);

-- >>> BEGIN verbatim resolve_canonical_owner (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.resolve_canonical_owner(addr text)
 RETURNS text
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(
    (SELECT parent_addr
     FROM linked_accounts
     WHERE child_addr = addr AND active = TRUE
     ORDER BY last_event_at DESC
     LIMIT 1),
    addr
  );
$function$;
-- <<< END verbatim resolve_canonical_owner <<<

-- An unlinked address resolves to itself (the COALESCE fallback).
SELECT _assert_eq(resolve_canonical_owner('0xchildNONE'), '0xchildNONE', 'unlinked → self');

-- A child with one active link resolves to its parent.
INSERT INTO linked_accounts VALUES ('0xparentA', '0xchild1', TRUE, '2026-01-01');
SELECT _assert_eq(resolve_canonical_owner('0xchild1'), '0xparentA', 'active child → parent');

-- The parent itself is not a child, so it resolves to itself.
SELECT _assert_eq(resolve_canonical_owner('0xparentA'), '0xparentA', 'parent → self');

-- Most-RECENT active link wins when a child was relinked to a new parent
-- (ORDER BY last_event_at DESC LIMIT 1).
INSERT INTO linked_accounts VALUES ('0xparentOld', '0xchild2', TRUE, '2026-01-01'),
                                   ('0xparentNew', '0xchild2', TRUE, '2026-06-01');
SELECT _assert_eq(resolve_canonical_owner('0xchild2'), '0xparentNew', 'newest active link wins');

-- An INACTIVE link is ignored — a de-linked child resolves to itself, never to
-- a stale parent (active = TRUE filter).
INSERT INTO linked_accounts VALUES ('0xparentZ', '0xchild3', FALSE, '2026-06-01');
SELECT _assert_eq(resolve_canonical_owner('0xchild3'), '0xchild3', 'inactive link ignored → self');

-- When a child has BOTH a newer inactive link and an older active one, the
-- active-only filter picks the active parent regardless of recency.
INSERT INTO linked_accounts VALUES ('0xparentActive', '0xchild4', TRUE,  '2026-02-01'),
                                   ('0xparentDead',   '0xchild4', FALSE, '2026-09-01');
SELECT _assert_eq(resolve_canonical_owner('0xchild4'), '0xparentActive', 'newer-but-inactive skipped for older-active');

SELECT '✓ resolve_canonical_owner invariants pass' AS result;
ROLLBACK;
