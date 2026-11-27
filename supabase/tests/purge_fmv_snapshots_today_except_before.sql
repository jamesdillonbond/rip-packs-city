-- DB invariant: public.purge_fmv_snapshots_today_except_before — fmv-recalc's replace-delete since 2026-11-27.
-- Everything purge_fmv_snapshots_today_except guaranteed (pre-today history untouched, scoped to the passed
-- editions, never a kept id), plus: rows computed at or after p_written_before (the calling run's start) are never
-- deleted, so two runs on the same page cannot delete each other's fresh rows (2026-11-27: two runs at offset 3000
-- did, and ~490 editions were left with no row for today).
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261127231105_audit_20261127_fmv_recalc_purge_spares_a_concurrent_runs_rows.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.fmv_snapshots (
  id          uuid,
  edition_id  uuid,
  computed_at timestamptz
);

-- >>> BEGIN verbatim purge_fmv_snapshots_today_except_before (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.purge_fmv_snapshots_today_except_before(
  p_edition_ids uuid[],
  p_today_start timestamptz,
  p_keep_ids uuid[],
  p_written_before timestamptz
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
    AND computed_at >= p_today_start
    AND computed_at < p_written_before
    AND NOT (id = ANY(COALESCE(p_keep_ids, '{}'::uuid[])));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
-- <<< END verbatim purge_fmv_snapshots_today_except_before <<<

\set e1 '''11111111-1111-1111-1111-111111111111'''
\set e2 '''22222222-2222-2222-2222-222222222222'''
\set k1 '''aaaaaaaa-0000-0000-0000-000000000001'''
\set o1 '''aaaaaaaa-0000-0000-0000-000000000002'''
\set y1 '''aaaaaaaa-0000-0000-0000-000000000003'''
\set s2 '''bbbbbbbb-0000-0000-0000-000000000001'''

-- The old guarantees, with the run started at 14:00Z.
INSERT INTO public.fmv_snapshots (id, edition_id, computed_at) VALUES
  (:k1::uuid, :e1::uuid, '2026-10-23T15:00:00Z'),  -- e1 today, JUST INSERTED (kept)   → keep
  (:o1::uuid, :e1::uuid, '2026-10-23T09:47:00Z'),  -- e1 today, older (replaced)       → purge
  (:y1::uuid, :e1::uuid, '2026-10-22T09:00:00Z'),  -- e1 yesterday (history)           → keep
  (:s2::uuid, :e2::uuid, '2026-10-23T09:47:00Z');  -- e2 today, run SKIPPED it          → keep

SELECT _assert_eq(
  public.purge_fmv_snapshots_today_except_before(ARRAY[:e1::uuid], '2026-10-23T00:00:00Z', ARRAY[:k1::uuid], '2026-10-23T14:00:00Z')::text, '1',
  'deletes only the replaced today row of a written edition');
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE id = :k1::uuid), '1',
  'the just-inserted (kept) row survives');
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE id = :y1::uuid), '1',
  'yesterday''s history row survives');
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE id = :s2::uuid), '1',
  'a SKIPPED edition keeps its today row from another writer (the 2026-10-23 bug)');

-- 2026-11-27: two runs on the same page. Run A started 14:48:07Z, run B 14:48:10Z; each wrote its row after both
-- had started. Each purge deletes only today's rows from BEFORE its own start (o3), keeps its own row by id, and
-- keeps the other run's row by time — the edition is never left with no row for today.
\set e3 '''33333333-3333-3333-3333-333333333333'''
\set o3 '''cccccccc-0000-0000-0000-000000000001'''
\set a1 '''cccccccc-0000-0000-0000-000000000002'''
\set b1 '''cccccccc-0000-0000-0000-000000000003'''
INSERT INTO public.fmv_snapshots (id, edition_id, computed_at) VALUES
  (:o3::uuid, :e3::uuid, '2026-11-27T10:48:00Z'),  -- e3 earlier today                   → replaced
  (:a1::uuid, :e3::uuid, '2026-11-27T14:48:40Z'),  -- run A's new row
  (:b1::uuid, :e3::uuid, '2026-11-27T14:48:45Z');  -- run B's new row (concurrent)

SELECT _assert_eq(
  public.purge_fmv_snapshots_today_except_before(ARRAY[:e3::uuid], '2026-11-27T00:00:00Z', ARRAY[:a1::uuid], '2026-11-27T14:48:07Z')::text, '1',
  'run A deletes only the row written before it started, not run B''s');
SELECT _assert_eq(
  public.purge_fmv_snapshots_today_except_before(ARRAY[:e3::uuid], '2026-11-27T00:00:00Z', ARRAY[:b1::uuid], '2026-11-27T14:48:10Z')::text, '0',
  'run B deletes nothing: run A''s row was written after B started');
SELECT _assert_eq((SELECT string_agg(id::text, ',' ORDER BY computed_at) FROM public.fmv_snapshots WHERE edition_id = :e3::uuid),
  'cccccccc-0000-0000-0000-000000000002,cccccccc-0000-0000-0000-000000000003',
  'both concurrent runs'' rows survive (readers take the newest); the edition is never left with no row for today');

ROLLBACK;
