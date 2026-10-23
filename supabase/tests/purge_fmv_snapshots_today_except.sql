-- DB invariant: public.purge_fmv_snapshots_today_except — the replace-delete of fmv-recalc's
-- INSERT-FIRST write (2026-10-23). After Step 4 inserts today's fresh rows, this clears TODAY's older
-- rows for exactly the editions written, keeping the rows just inserted. The guards that matter:
-- it must NOT touch pre-today history, must be SCOPED to the passed editions (an edition the run
-- skipped keeps its today row from another writer — the bug this function exists to close), and must
-- NEVER delete a kept (just-inserted) id. A NULL keep-list means "keep nothing".
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261023151316_audit_20261023_fmv_recalc_replace_delete_keeps_what_it_did_not_write.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.fmv_snapshots (
  id          uuid,
  edition_id  uuid,
  computed_at timestamptz
);

-- >>> BEGIN verbatim purge_fmv_snapshots_today_except (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.purge_fmv_snapshots_today_except(
  p_edition_ids uuid[],
  p_today_start timestamptz,
  p_keep_ids uuid[]
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
    AND NOT (id = ANY(COALESCE(p_keep_ids, '{}'::uuid[])));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
-- <<< END verbatim purge_fmv_snapshots_today_except <<<

\set e1 '''11111111-1111-1111-1111-111111111111'''
\set e2 '''22222222-2222-2222-2222-222222222222'''
\set k1 '''aaaaaaaa-0000-0000-0000-000000000001'''
\set o1 '''aaaaaaaa-0000-0000-0000-000000000002'''
\set y1 '''aaaaaaaa-0000-0000-0000-000000000003'''
\set s2 '''bbbbbbbb-0000-0000-0000-000000000001'''

INSERT INTO public.fmv_snapshots (id, edition_id, computed_at) VALUES
  (:k1::uuid, :e1::uuid, '2026-10-23T15:00:00Z'),  -- e1 today, JUST INSERTED (kept)   → keep
  (:o1::uuid, :e1::uuid, '2026-10-23T09:47:00Z'),  -- e1 today, older (replaced)       → purge
  (:y1::uuid, :e1::uuid, '2026-10-22T09:00:00Z'),  -- e1 yesterday (history)           → keep
  (:s2::uuid, :e2::uuid, '2026-10-23T09:47:00Z');  -- e2 today, run SKIPPED it          → keep

-- The run wrote e1 only (e2 was skipped), keeping its new row k1.
SELECT _assert_eq(
  public.purge_fmv_snapshots_today_except(ARRAY[:e1::uuid], '2026-10-23T00:00:00Z', ARRAY[:k1::uuid])::text, '1',
  'deletes only the replaced today row of a written edition');

SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE id = :k1::uuid), '1',
  'the just-inserted (kept) row survives');
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE id = :y1::uuid), '1',
  'yesterday''s history row survives');
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE id = :s2::uuid), '1',
  'a SKIPPED edition keeps its today row from another writer (the 2026-10-23 bug)');

-- A NULL keep-list keeps nothing: the remaining e1 today row (k1) is now purged.
SELECT _assert_eq(
  public.purge_fmv_snapshots_today_except(ARRAY[:e1::uuid], '2026-10-23T00:00:00Z', NULL)::text, '1',
  'a NULL keep-list purges every today row of the edition');
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots WHERE edition_id = :e1::uuid), '1',
  'only the pre-today row of e1 remains');

ROLLBACK;
