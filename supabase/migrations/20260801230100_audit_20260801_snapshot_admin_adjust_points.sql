-- Snapshot migration: public.admin_adjust_points(uuid,integer,integer,text,text).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: the ADMIN OVERRIDE into the reward-points economy (the earn path
-- is award_points, already pinned). It writes a single 'adjust' points_ledger row
-- credited to `admin:<who>`. Load-bearing guards: null-user reject and a NO-OP
-- reject (both delta and status_delta zero after COALESCE) — each must write NO
-- ledger row; the happy path writes exactly one adjust row and returns the
-- running spendable/status totals.

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
