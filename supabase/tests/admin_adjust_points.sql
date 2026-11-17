-- DB invariant: public.admin_adjust_points(uuid,integer,integer,text,text) — the
-- ADMIN OVERRIDE into the reward-points economy (the earn path is award_points,
-- pinned separately). It writes a single 'adjust' points_ledger row credited to
-- `admin:<who>`. Because it is a direct write to a live currency, its guards are
-- load-bearing: null-user reject and a NO-OP reject (both deltas zero after
-- COALESCE) must write NO ledger row; the happy path writes exactly one adjust
-- row carrying the right delta/status/kind/reason/created_by and returns the
-- running spendable/status totals. NULL deltas COALESCE to 0 (so a status-only
-- adjust with a null point delta still lands, as delta 0).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801230100_audit_20260801_snapshot_admin_adjust_points.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (a1dd9d0dc26fac9ee5cf9ab5ad2169d1).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE points_ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  user_id      uuid,
  delta        bigint,
  status_delta bigint,
  kind         text,
  reason       text,
  ref          text,
  created_by   text,
  created_at   timestamptz DEFAULT now()
);

-- >>> BEGIN verbatim admin_adjust_points (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.admin_adjust_points(p_user_id uuid, p_delta integer, p_status_delta integer, p_reason text, p_admin text DEFAULT 'owner'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ledger_id bigint; v_spendable bigint; v_status bigint;
BEGIN
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','null_user'); END IF;
  IF coalesce(p_delta,0)=0 AND coalesce(p_status_delta,0)=0 THEN RETURN jsonb_build_object('ok',false,'error','no_op'); END IF;
  INSERT INTO points_ledger(user_id, delta, status_delta, kind, reason, created_by)
  VALUES (p_user_id, coalesce(p_delta,0), coalesce(p_status_delta,0), 'adjust', coalesce(p_reason,'admin_adjust'), 'admin:'||coalesce(p_admin,'owner'))
  RETURNING id INTO v_ledger_id;
  SELECT coalesce(sum(delta),0), coalesce(sum(status_delta),0) INTO v_spendable, v_status FROM points_ledger WHERE user_id=p_user_id;
  RETURN jsonb_build_object('ok',true,'ledger_id',v_ledger_id,'spendable',v_spendable,'status',v_status);
END $function$;
-- <<< END verbatim admin_adjust_points <<<

-- U1 = ...0001
-- 1) null user → error, no row.
SELECT _assert_eq((admin_adjust_points(NULL, 10, 0, 'x')->>'error'), 'null_user', 'null user → null_user');
SELECT _assert_eq((SELECT count(*)::text FROM points_ledger), '0', 'null user writes no row');

-- 2) NO-OP: both deltas explicitly zero → error, no row.
SELECT _assert_eq((admin_adjust_points('00000000-0000-0000-0000-000000000001', 0, 0, 'x')->>'error'),
  'no_op', 'zero/zero → no_op');
-- 2b) NO-OP via NULLs: both deltas NULL COALESCE to 0 → no_op.
SELECT _assert_eq((admin_adjust_points('00000000-0000-0000-0000-000000000001', NULL, NULL, 'x')->>'error'),
  'no_op', 'null/null → no_op (COALESCE 0)');
SELECT _assert_eq((SELECT count(*)::text FROM points_ledger), '0', 'no-op paths write no row');

-- 3) HAPPY: full adjust writes exactly one 'adjust' row with the right fields.
SELECT _assert_eq(
  (admin_adjust_points('00000000-0000-0000-0000-000000000001', 100, 50, 'comp', 'trevor')->>'spendable'),
  '100', 'happy adjust reports running spendable');
SELECT _assert_eq(
  (SELECT delta||'|'||status_delta||'|'||kind||'|'||reason||'|'||created_by
     FROM points_ledger WHERE user_id='00000000-0000-0000-0000-000000000001'),
  '100|50|adjust|comp|admin:trevor', 'row carries delta/status/kind/reason/admin credit');

-- 4) STATUS-ONLY: null point delta + a status delta → NOT a no-op; delta lands as 0.
SELECT _assert_eq(
  (admin_adjust_points('00000000-0000-0000-0000-000000000001', NULL, 5, 'promote')->>'status'),
  '55', 'status-only adjust lands and updates running status total (50+5)');
SELECT _assert_eq(
  (SELECT delta::text FROM points_ledger WHERE reason='promote'), '0',
  'null point delta stored as 0');

-- 5) DEFAULTS: null reason → 'admin_adjust', default admin → 'owner'.
SELECT admin_adjust_points('00000000-0000-0000-0000-000000000001', 7, 0, NULL);
SELECT _assert_eq(
  (SELECT reason||'|'||created_by FROM points_ledger WHERE delta=7 AND status_delta=0),
  'admin_adjust|admin:owner', 'defaults: reason=admin_adjust, admin=owner');

SELECT '✓ admin_adjust_points invariants pass' AS result;
ROLLBACK;
