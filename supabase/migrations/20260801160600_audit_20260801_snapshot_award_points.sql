-- Snapshot migration: public.award_points(uuid,text,text).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: mints reward points into points_ledger. As the reward-currency
-- writer it is the abuse surface for the rewards/referral economy, so its guards
-- are load-bearing: null-user reject, unknown/inactive action reject, per-user
-- lifetime limit, per-day cap, cooldown between earns, and a global per-day earn
-- backstop — each a distinct early-return that must NOT write a ledger row.

CREATE OR REPLACE FUNCTION public.award_points(p_user_id uuid, p_action_key text, p_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_today int; v_total int; v_last timestamptz;
  v_spendable bigint; v_status bigint; v_ledger_id bigint;
  v_cap int; v_today_earned bigint;
BEGIN
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('awarded',false,'error','null_user'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('rpc_rewards'), hashtext(p_user_id::text));
  SELECT * INTO r FROM points_rules WHERE action_key = p_action_key AND active LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('awarded',false,'error','unknown_or_inactive_action'); END IF;

  IF r.per_user_limit IS NOT NULL THEN
    SELECT count(*) INTO v_total FROM points_ledger WHERE user_id=p_user_id AND reason=p_action_key AND kind='earn';
    IF v_total >= r.per_user_limit THEN RETURN jsonb_build_object('awarded',false,'skipped','per_user_limit_reached'); END IF;
  END IF;

  IF r.daily_cap IS NOT NULL THEN
    SELECT count(*) INTO v_today FROM points_ledger
     WHERE user_id=p_user_id AND reason=p_action_key AND kind='earn' AND created_at >= date_trunc('day', now());
    IF v_today >= r.daily_cap THEN RETURN jsonb_build_object('awarded',false,'skipped','daily_cap_reached'); END IF;
  END IF;

  IF r.cooldown_seconds > 0 THEN
    SELECT max(created_at) INTO v_last FROM points_ledger WHERE user_id=p_user_id AND reason=p_action_key AND kind='earn';
    IF v_last IS NOT NULL AND v_last > now() - make_interval(secs => r.cooldown_seconds)
      THEN RETURN jsonb_build_object('awarded',false,'skipped','cooldown'); END IF;
  END IF;

  -- Global daily earn backstop
  SELECT int_value INTO v_cap FROM rewards_config WHERE key='global_daily_earn_cap';
  IF v_cap IS NOT NULL THEN
    SELECT coalesce(sum(delta),0) INTO v_today_earned FROM points_ledger
      WHERE user_id=p_user_id AND kind='earn' AND created_at >= date_trunc('day', now());
    IF v_today_earned + r.points > v_cap THEN
      RETURN jsonb_build_object('awarded',false,'skipped','global_daily_cap_reached','cap',v_cap,'today',v_today_earned);
    END IF;
  END IF;

  INSERT INTO points_ledger(user_id, delta, status_delta, kind, reason, ref, created_by)
  VALUES (p_user_id, r.points, r.points, 'earn', p_action_key, p_ref, 'system')
  RETURNING id INTO v_ledger_id;

  SELECT coalesce(sum(delta),0), coalesce(sum(status_delta),0) INTO v_spendable, v_status
    FROM points_ledger WHERE user_id=p_user_id;
  RETURN jsonb_build_object('awarded',true,'points',r.points,'action',p_action_key,'ledger_id',v_ledger_id,
                            'spendable',v_spendable,'status',v_status,'tier',rewards_tier(v_status::int));
END $function$;
