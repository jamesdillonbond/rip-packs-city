-- audit_20260721_get_weekly_portfolio_movers
--
-- Data layer for the weekly retention email (P3 follow-up). Read-only SECDEF,
-- service_role only (it returns auth.users.email — anon/authenticated REVOKED).
-- Returns one row per authenticated owner with >= p_days of portfolio history,
-- ranked by absolute week-over-week FMV move. owner_key in portfolio_snapshots
-- is the auth user id (text), joined to auth.users for the email.
--
-- NOTE: this function was applied live via MCP on 2026-07-21 (Cowork). This file
-- is committed for repo parity; re-applying is harmless (CREATE OR REPLACE).
--
-- Revert: DROP FUNCTION public.get_weekly_portfolio_movers(numeric, integer);

CREATE OR REPLACE FUNCTION public.get_weekly_portfolio_movers(
  p_min_abs_pct numeric DEFAULT 0,
  p_days integer DEFAULT 7
)
RETURNS TABLE(
  user_id uuid,
  email text,
  latest_date date,
  latest_fmv numeric,
  prior_date date,
  prior_fmv numeric,
  delta_usd numeric,
  delta_pct numeric,
  moment_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
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

-- SECDEF returning emails: lock down to service_role only.
REVOKE ALL ON FUNCTION public.get_weekly_portfolio_movers(numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_weekly_portfolio_movers(numeric, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_weekly_portfolio_movers(numeric, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_weekly_portfolio_movers(numeric, integer) TO service_role;
