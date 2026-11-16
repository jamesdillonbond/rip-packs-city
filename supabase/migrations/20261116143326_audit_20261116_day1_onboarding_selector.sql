-- audit_20261116_day1_onboarding_selector
--
-- Read-only selector for the day-1 onboarding email (app/api/cron/day1-onboarding).
-- Trevor 2026-11-16: "Figure out the day 1 email and additional funnel building".
--
-- Who: a confirmed, non-internal account created between p_min_hours and
-- p_max_hours ago that has NOT come back on a second Pacific-time day, split in
-- two:
--   segment 'no_wallet' — no saved wallet yet (3 of 24 signups in the 30 days to
--                         11-16 were still in this state after 24 h);
--   segment 'wallet'    — saved a wallet but no second-day visit (6 of 21).
-- A member already back on a second day is excluded: they need no nudge.
--
-- The collection value is the DASHBOARD's headline, computed the same way as
-- app/api/profile/collection-stats (line ~156): per saved_wallets row,
-- greatest(0, cached_fmv_usd − cached_fmv_stale_usd), summed over rows with a
-- cache stamp. No stamped row → NULL, never 0 (a missing value must not read as
-- "your collection is worth $0").
--
-- SECURITY DEFINER (it reads auth.users) + service_role-only EXECUTE.
-- anon-exec: revoked (get_day1_onboarding_candidates) — new function; REVOKE FROM PUBLIC, anon, authenticated below, service_role only.

CREATE OR REPLACE FUNCTION public.get_day1_onboarding_candidates(
  p_min_hours integer DEFAULT 20,
  p_max_hours integer DEFAULT 72
)
RETURNS TABLE(
  user_id uuid,
  email text,
  username text,
  segment text,
  fmv_usd numeric,
  moment_count bigint,
  hours_since_signup numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH u AS (
    SELECT au.id, lower(au.email::text) AS email, au.created_at
    FROM auth.users au
    WHERE au.created_at <= now() - make_interval(hours => p_min_hours)
      AND au.created_at >= now() - make_interval(hours => p_max_hours)
      AND au.email IS NOT NULL
      AND au.email_confirmed_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.internal_accounts ia WHERE ia.user_id = au.id)
  ),
  w AS (
    SELECT sw.user_id,
           sum(greatest(0, coalesce(sw.cached_fmv_usd, 0) - coalesce(sw.cached_fmv_stale_usd, 0)))
             FILTER (WHERE sw.cache_updated_at IS NOT NULL) AS fmv_usd,
           sum(sw.cached_moment_count) FILTER (WHERE sw.cache_updated_at IS NOT NULL) AS moment_count,
           (array_agg(sw.username ORDER BY sw.pinned_at DESC NULLS LAST)
              FILTER (WHERE sw.username IS NOT NULL AND sw.username <> ''))[1] AS username
    FROM public.saved_wallets sw
    WHERE sw.user_id IN (SELECT id FROM u)
    GROUP BY sw.user_id
  ),
  d AS (
    SELECT ue.user_id,
           count(DISTINCT (ue.occurred_at AT TIME ZONE 'America/Los_Angeles')::date) AS days
    FROM public.usage_events ue
    WHERE ue.user_id IN (SELECT id FROM u)
      AND ue.occurred_at >= now() - make_interval(hours => p_max_hours + 24)
    GROUP BY ue.user_id
  )
  SELECT u.id,
         u.email,
         coalesce(w.username, nullif(up.username, ''), nullif(up.topshot_username, '')),
         CASE WHEN w.user_id IS NULL THEN 'no_wallet' ELSE 'wallet' END,
         CASE WHEN w.fmv_usd IS NULL THEN NULL ELSE round(w.fmv_usd, 2) END,
         w.moment_count,
         round(EXTRACT(EPOCH FROM (now() - u.created_at)) / 3600.0, 1)
  FROM u
  LEFT JOIN w ON w.user_id = u.id
  LEFT JOIN d ON d.user_id = u.id
  LEFT JOIN public.user_profiles up ON up.id = u.id
  WHERE coalesce(d.days, 0) < 2
  ORDER BY u.created_at ASC;
$function$;

REVOKE ALL ON FUNCTION public.get_day1_onboarding_candidates(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_day1_onboarding_candidates(integer, integer) TO service_role;
