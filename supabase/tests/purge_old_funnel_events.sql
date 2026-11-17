-- DB invariant: public.purge_old_funnel_events — the 180-day retention sweep
-- for ANONYMOUS page-view / click telemetry, called by run_weekly_log_purges()
-- with an explicit 180 (pg_cron `rpc-weekly-log-purges`).
--
-- ⚠ WHY A PIN. Two properties are load-bearing and both fail SILENTLY:
--   1. `user_id IS NULL` — rows tied to an account are campaign attribution
--      (trophy_case_campaign_users reads trophy_pinned by user) and traction
--      history. A sweep that drops the predicate erases a campaign's first-pin
--      evidence with no error and a SMALLER number everyone agrees with.
--   2. the `<` boundary and the p_days_keep argument — a body that hardcodes
--      180 or slips to `<=` cannot pass the cases below.
-- The privacy policy states this retention; the pin is what keeps it true.
--
-- DDL is VERBATIM from
-- supabase/migrations/20261012041115_audit_20261011_funnel_events_anon_telemetry_180d_retention.sql
-- (drift guard: __tests__/db-invariants-drift-guard.test.ts).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Types per information_schema: id uuid, user_id uuid NULL, created_at timestamptz.
CREATE TABLE public.funnel_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  user_id    uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- >>> BEGIN verbatim purge_old_funnel_events >>>
CREATE OR REPLACE FUNCTION public.purge_old_funnel_events(p_days_keep integer DEFAULT 180)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  -- Anonymous telemetry only. Rows with a user_id are account data (the
  -- trophy-case campaign view and the traction snapshot read them by user) and
  -- live as long as the account does; the privacy policy says exactly that.
  DELETE FROM funnel_events
  WHERE created_at < NOW() - (p_days_keep || ' days')::interval
    AND user_id IS NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
-- <<< END verbatim purge_old_funnel_events <<<

INSERT INTO public.funnel_events (event_type, user_id, created_at) VALUES
  ('home_view',     NULL, now() - interval '400 days'),  -- anon, ancient        → purge
  ('home_view',     NULL, now() - interval '181 days'),  -- anon, outside window → purge
  ('home_view',     NULL, now() - interval '180 days'),  -- anon, EXACT cutoff   → keep (`<`)
  ('home_view',     NULL, now() - interval '179 days'),  -- anon, inside window  → keep
  ('trophy_pinned', '00000000-0000-0000-0000-000000000001', now() - interval '400 days'), -- account-tied, ancient → KEEP
  ('signin_click',  '00000000-0000-0000-0000-000000000002', now() - interval '181 days'), -- account-tied          → KEEP
  ('home_view',     NULL, now());                        -- anon, right now      → keep

SELECT _assert_eq(public.purge_old_funnel_events()::text, '2',
  'default 180-day retention deletes exactly the two ANONYMOUS rows older than the cutoff');

SELECT _assert_eq((SELECT count(*)::text FROM public.funnel_events), '5',
  'the boundary row, the in-window rows and every account-tied row survive');

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.funnel_events WHERE user_id IS NOT NULL), '2',
  'account-tied rows are never touched, however old — they are campaign attribution and traction history');

SELECT _assert(
  (SELECT count(*) FROM public.funnel_events
    WHERE user_id IS NULL
      AND created_at BETWEEN now() - interval '180 days' - interval '1 second'
                         AND now() - interval '180 days' + interval '1 second') = 1,
  'a row EXACTLY on the 180-day cutoff is kept (the < vs <= boundary)');

-- Driven with a non-default argument so a body that hardcodes 180 cannot pass.
SELECT _assert_eq(public.purge_old_funnel_events(100)::text, '2',
  'a 100-day window reaches the 180- and 179-day anonymous rows the default sweep left behind');
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.funnel_events WHERE user_id IS NOT NULL), '2',
  'and still never an account-tied row');

ROLLBACK;
