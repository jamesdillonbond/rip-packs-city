-- 2026-11-02 — get_weekly_portfolio_movers compares like-for-like snapshots.
--
-- Found during the email Stage B dry check: the weekly digest would have told a real
-- collector "your portfolio moved +990.9% this week". Their 2026-10-26 snapshot was a
-- PARTIAL read (356 moments vs 3,164 the day before and 3,167 the day after), and the
-- function took that row as the prior week. Partial snapshots recur on Sundays
-- (10-05, 10-12, 10-19, 10-26; 9 owner-days in 60) — the writer issue is filed
-- separately in known-issues; this migration closes the READER that turns one into a
-- user-facing claim.
--
-- Rule: the prior is the newest snapshot within [latest - p_days - 3, latest - p_days]
-- whose moment_count is within 0.75x..1.33x of the latest's. No comparable prior → the
-- owner is not a mover this week (no email), never a fabricated percentage.
--
-- Revert: re-apply the body from 20260721120000_audit_20260721_get_weekly_portfolio_movers.sql.
CREATE OR REPLACE FUNCTION public.get_weekly_portfolio_movers(p_min_abs_pct numeric DEFAULT 0, p_days integer DEFAULT 7)
 RETURNS TABLE(user_id uuid, email text, latest_date date, latest_fmv numeric, prior_date date, prior_fmv numeric, delta_usd numeric, delta_pct numeric, moment_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH latest AS (
    SELECT DISTINCT ON (owner_key) owner_key, snapshot_date, total_fmv, moment_count
    FROM public.portfolio_snapshots
    ORDER BY owner_key, snapshot_date DESC
  ),
  prior AS (
    SELECT DISTINCT ON (ps.owner_key) ps.owner_key, ps.snapshot_date, ps.total_fmv
    FROM public.portfolio_snapshots ps
    JOIN latest l ON l.owner_key = ps.owner_key
    WHERE ps.snapshot_date <= l.snapshot_date - p_days
      AND ps.snapshot_date >= l.snapshot_date - p_days - 3
      AND ps.moment_count >= l.moment_count * 0.75
      AND ps.moment_count <= l.moment_count * 1.33
    ORDER BY ps.owner_key, ps.snapshot_date DESC
  )
  SELECT
    u.id AS user_id,
    u.email::text AS email,
    l.snapshot_date AS latest_date,
    round(l.total_fmv, 2) AS latest_fmv,
    p.snapshot_date AS prior_date,
    round(p.total_fmv, 2) AS prior_fmv,
    round(l.total_fmv - p.total_fmv, 2) AS delta_usd,
    CASE WHEN p.total_fmv > 0
         THEN round((l.total_fmv - p.total_fmv) / p.total_fmv * 100, 2)
    END AS delta_pct,
    l.moment_count
  FROM latest l
  JOIN prior p ON p.owner_key = l.owner_key
  JOIN auth.users u ON u.id::text = l.owner_key
  WHERE l.total_fmv > 0
    AND u.email IS NOT NULL
    AND (
      p_min_abs_pct = 0
      OR (p.total_fmv > 0 AND abs((l.total_fmv - p.total_fmv) / p.total_fmv * 100) >= p_min_abs_pct)
    )
  ORDER BY abs(l.total_fmv - p.total_fmv) DESC;
$function$;

-- anon-execute decision: REVOKED — it returns auth.users.email; service_role only (unchanged from 20260721120000).
REVOKE ALL ON FUNCTION public.get_weekly_portfolio_movers(numeric, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_weekly_portfolio_movers(numeric, integer) TO service_role;
