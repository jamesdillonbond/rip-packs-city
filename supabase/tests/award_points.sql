-- DB invariant: public.award_points(uuid,text,text) — the reward-currency mint.
-- It writes points into points_ledger and is the abuse surface for the rewards /
-- referral economy, so every guard is load-bearing: null-user reject, unknown /
-- inactive action reject, per-user lifetime limit, per-day cap, cooldown, and a
-- global per-day earn backstop. The pinned properties: each guard returns the
-- right skip/error reason AND writes NO ledger row; the happy path inserts
-- exactly one earn row and reports the running spendable total.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801160600_audit_20260801_snapshot_award_points.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- rewards_tier() is an external dependency, STUBBED to a constant marker.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE points_rules (
  action_key       text,
  active           boolean,
  points           int,
  per_user_limit   int,
  daily_cap        int,
  cooldown_seconds int
);
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
CREATE TABLE rewards_config (key text, int_value int);
CREATE OR REPLACE FUNCTION public.rewards_tier(p int) RETURNS text LANGUAGE sql AS $$ SELECT 'tier:'||p::text $$;

-- >>> BEGIN verbatim award_points (keep byte-identical to the migration) >>>
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
-- <<< END verbatim award_points <<<

-- U = 00000000-0000-0000-0000-000000000001
-- Guard: null user → error null_user, no row.
SELECT _assert_eq((award_points(NULL,'link_wallet')->>'error'), 'null_user', 'null user → null_user');

-- Guard: unknown action → error unknown_or_inactive_action.
SELECT _assert_eq((award_points('00000000-0000-0000-0000-000000000001','nope')->>'error'),
  'unknown_or_inactive_action', 'unknown action rejected');

-- Guard: INACTIVE rule is invisible (active=false) → unknown_or_inactive_action.
INSERT INTO points_rules VALUES ('inactive_act', FALSE, 10, NULL, NULL, 0);
SELECT _assert_eq((award_points('00000000-0000-0000-0000-000000000001','inactive_act')->>'error'),
  'unknown_or_inactive_action', 'inactive rule not awardable');

-- Happy path: a simple active rule (no limits) awards points + writes one row.
INSERT INTO points_rules VALUES ('link_wallet', TRUE, 50, NULL, NULL, 0);
SELECT _assert(
  (award_points('00000000-0000-0000-0000-000000000001','link_wallet','ref1')->>'awarded')::boolean,
  'active rule → awarded=true');
SELECT _assert_eq((SELECT count(*)::text FROM points_ledger WHERE reason='link_wallet'), '1', 'one earn row written');
SELECT _assert_eq((SELECT (delta::text||'|'||kind||'|'||ref) FROM points_ledger WHERE reason='link_wallet'),
  '50|earn|ref1', 'row carries points/kind/ref');

-- per_user_limit: a rule capped at 1 lifetime earn — second call skipped, no 2nd row.
INSERT INTO points_rules VALUES ('once_only', TRUE, 5, 1, NULL, 0);
SELECT award_points('00000000-0000-0000-0000-000000000001','once_only');  -- consumes the single allowance
SELECT _assert_eq((award_points('00000000-0000-0000-0000-000000000001','once_only')->>'skipped'),
  'per_user_limit_reached', 'lifetime limit blocks the 2nd earn');
SELECT _assert_eq((SELECT count(*)::text FROM points_ledger WHERE reason='once_only'), '1', 'no 2nd row past per_user_limit');

-- cooldown: a rule with a long cooldown — the immediate 2nd call is skipped.
INSERT INTO points_rules VALUES ('cooled', TRUE, 5, NULL, NULL, 3600);
SELECT award_points('00000000-0000-0000-0000-000000000001','cooled');
SELECT _assert_eq((award_points('00000000-0000-0000-0000-000000000001','cooled')->>'skipped'),
  'cooldown', 'cooldown blocks a rapid re-earn');

-- daily_cap: a rule capped at 1/day — 2nd same-day earn skipped.
INSERT INTO points_rules VALUES ('daily1', TRUE, 5, NULL, 1, 0);
SELECT award_points('00000000-0000-0000-0000-000000000001','daily1');
SELECT _assert_eq((award_points('00000000-0000-0000-0000-000000000001','daily1')->>'skipped'),
  'daily_cap_reached', 'daily cap blocks the 2nd same-day earn');

-- global_daily_earn_cap: a tiny global cap that the next earn would exceed → skip.
INSERT INTO rewards_config VALUES ('global_daily_earn_cap', 1);
INSERT INTO points_rules VALUES ('big', TRUE, 1000, NULL, NULL, 0);
SELECT _assert_eq((award_points('00000000-0000-0000-0000-000000000001','big')->>'skipped'),
  'global_daily_cap_reached', 'global daily backstop blocks an over-cap earn');

SELECT '✓ award_points invariants pass' AS result;
ROLLBACK;
