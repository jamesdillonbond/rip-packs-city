-- audit_20260724_cold_signup_reminder_selector
-- Read-only selector for the cold-signup reminder: re-engage approved allow_list
-- users who never completed first login (the chase.standen pattern). Returns
-- eligible rows + a stage label; SENDS NOTHING. The gated cron route
-- (/api/cron/signup-reminder, env SIGNUP_REMINDER_ENABLED) consumes this and
-- dedups per (email,stage) via alert_deliveries.
--   * status='active', not revoked, welcome email actually sent (we reached them)
--   * NO auth.users row (never logged in) — needs the auth.users join, hence SECDEF
--   * approved between p_min_hours ago and p_max_days ago (skip the stale tail:
--     a 45-77 day-late nudge is spam; only recent cold signups are in-window)
-- SECURITY DEFINER + service_role-only ACL (explicit anon/authenticated REVOKE
-- per the Supabase default-grant trap).
--
-- Applied to prod via MCP as audit_20260724_cold_signup_reminder_selector; this
-- file is repo/rebuild parity (idempotent CREATE OR REPLACE).
-- REVERT: DROP FUNCTION public.get_cold_signup_reminders(integer, integer);

CREATE OR REPLACE FUNCTION public.get_cold_signup_reminders(
  p_min_hours integer DEFAULT 24,
  p_max_days integer DEFAULT 14
)
RETURNS TABLE(
  email text,
  wallet_addr text,
  username text,
  approved_at timestamptz,
  hours_since_approved numeric,
  stage text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    lower(a.email)                                                       AS email,
    a.wallet_addr,
    a.username,
    a.approved_at,
    round(EXTRACT(EPOCH FROM (now() - a.approved_at)) / 3600.0, 1)       AS hours_since_approved,
    CASE WHEN now() - a.approved_at < interval '72 hours'
         THEN 'nudge1' ELSE 'nudge2' END                                AS stage
  FROM public.allow_list a
  LEFT JOIN auth.users u ON lower(u.email) = lower(a.email)
  WHERE a.status = 'active'
    AND a.revoked_at IS NULL
    AND a.email IS NOT NULL
    AND a.welcome_email_sent_at IS NOT NULL
    AND u.id IS NULL
    AND a.approved_at <= now() - make_interval(hours => p_min_hours)
    AND a.approved_at >= now() - make_interval(days  => p_max_days)
  ORDER BY a.approved_at ASC;
$function$;

REVOKE ALL ON FUNCTION public.get_cold_signup_reminders(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cold_signup_reminders(integer, integer) TO service_role;
