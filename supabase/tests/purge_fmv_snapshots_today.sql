-- DB invariant: public.purge_fmv_snapshots_today — the delete half of the
-- delete-then-insert FMV write pattern. Before a recalc writes today's fresh
-- snapshots for a batch of editions it clears TODAY's existing rows for exactly
-- those editions, so the day ends with one snapshot per edition instead of
-- duplicates. The two guards that matter: it must NOT touch snapshots computed
-- BEFORE today (that is the intentional daily history), and it must be SCOPED to
-- the passed editions (a widened predicate would wipe other editions' history).
-- It returns the row count deleted.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260713020000_audit_20260713_purge_fmv_snapshots_today_lock_timeout.sql),
-- verified byte-identical to the live prod definition via pg_get_functiondef on
-- 2026-07-31. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.fmv_snapshots (
  edition_id  uuid,
  computed_at timestamptz
);

-- >>> BEGIN verbatim purge_fmv_snapshots_today (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.purge_fmv_snapshots_today(
  p_edition_ids uuid[],
  p_today_start timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout TO '25s'
SET statement_timeout TO '60s'
AS $function$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM public.fmv_snapshots
  WHERE edition_id = ANY(p_edition_ids)
    AND computed_at >= p_today_start;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
-- <<< END verbatim purge_fmv_snapshots_today <<<

\set e1 '''11111111-1111-1111-1111-111111111111'''
\set e2 '''22222222-2222-2222-2222-222222222222'''
\set e3 '''33333333-3333-3333-3333-333333333333'''

INSERT INTO public.fmv_snapshots (edition_id, computed_at) VALUES
  (:e1::uuid, '2026-07-31T02:00:00Z'),  -- e1 today (>= start) → purge
  (:e1::uuid, '2026-07-31T09:00:00Z'),  -- e1 today (a duplicate)   → purge
  (:e1::uuid, '2026-07-30T09:00:00Z'),  -- e1 YESTERDAY             → keep (history)
  (:e2::uuid, '2026-07-31T05:00:00Z'),  -- e2 today, but NOT in the batch → keep (scope)
  (:e3::uuid, '2026-07-31T05:00:00Z');  -- e3 today, in the batch  → purge

-- Purge today's rows for {e1, e3} only. today_start = 2026-07-31 00:00Z.
SELECT _assert_eq(
  public.purge_fmv_snapshots_today(ARRAY[:e1::uuid, :e3::uuid], '2026-07-31T00:00:00Z')::text, '3',
  'returns the exact count deleted (two e1-today + one e3-today = 3)');

-- e1''s YESTERDAY row survives — daily history is preserved.
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots
  WHERE edition_id = :e1::uuid), '1', 'the pre-today (yesterday) snapshot is NOT purged — history kept');
SELECT _assert_eq((SELECT to_char(min(computed_at) AT TIME ZONE 'UTC','YYYY-MM-DD') FROM public.fmv_snapshots
  WHERE edition_id = :e1::uuid), '2026-07-30', 'the surviving e1 row is the yesterday one');

-- e2 is out of the batch → untouched even though it has a today row.
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots
  WHERE edition_id = :e2::uuid), '1', 'an edition NOT in the batch keeps its today snapshot (scoping)');

-- e3''s today row is gone.
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots
  WHERE edition_id = :e3::uuid), '0', 'a batched edition''s today snapshot is deleted');

-- Idempotent / no-match → returns 0.
SELECT _assert_eq(
  public.purge_fmv_snapshots_today(ARRAY[:e1::uuid, :e3::uuid], '2026-07-31T00:00:00Z')::text, '0',
  'a second purge finds no today rows for the batch → returns 0');

SELECT '✓ purge_fmv_snapshots_today invariants pass' AS result;
ROLLBACK;
