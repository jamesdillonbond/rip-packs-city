-- audit_20261011_traction_activity_wau_mau_excluding_internal_accounts
-- anon-exec: revoked (get_rpc_traction_activity) — NEW SECDEF reader over auth.users, usage_events and
--   funnel_events; REVOKE FROM PUBLIC, anon, authenticated below, GRANT service_role only. Its one caller
--   is the token-gated admin proxy /api/admin/analytics-overview (supabaseAdmin).
--
-- WHY. Platform review 2026-10-11 (docs/audits/platform-review-security-marketing-seo-compliance-
-- 2026-10-11.md §4 M3): the roadmap's go-live gates are stated in WAU ("no paid tier until 100 WAU"),
-- and the product could not measure WAU. The admin analytics page had one "Total Signups" tile;
-- `get_rpc_traction_snapshot()` (read live before writing this — prosrc, not inferred) counts
-- allow_list rows, outbound clicks, concierge sessions and funnel events by SESSION, and carries no
-- WAU, MAU or return-rate at all. Every WAU in docs/reference/roadmap-status.md is a hand-run sample.
--
-- WHAT THIS ADDS — one jsonb snapshot, all EXCLUDING public.internal_accounts (CLAUDE.md: traction
-- counts exclude internal accounts; a QA account goes in that table the turn it is created):
--   accounts_total           auth.users minus internal accounts (the authoritative account signal —
--                            AuthConfirmClient.tsx: "the authoritative 'new account' count is
--                            auth.users.created_at"; user_profiles is written lazily by two touch paths
--                            and would under-count)
--   signups_7d / signups_30d accounts created in the window
--   wau / mau                DISTINCT user_id with any activity in the last 7 / 30 days, where activity
--                            is usage_events(occurred_at) UNION funnel_events(created_at) — the two
--                            event tables that carry a user_id. ⚠ Anonymous activity (user_id NULL) is
--                            NOT a user and is not counted; this is active ACCOUNTS, by construction.
--   d7_cohort / d7_returned / d7_return_pct
--                            accounts created 14..7 days ago; of those, how many have ANY activity at or
--                            after creation + 7 days. The pct is NULL when the cohort is empty — a rate
--                            over nobody is not 0 % (the fabricated-divisor shape), and the client renders
--                            NULL as "—".
--   d30_cohort / d30_returned / d30_return_pct
--                            the same at 30 days over accounts created 60..30 days ago.
--   basis                    a one-line statement of the definitions above, carried in the payload so a
--                            reader of the tile can see what the number means without opening this file.
--
-- THREE STATES on the client (app/admin/analytics/AdminAnalyticsClient.tsx TractionPanel): the RPC
-- failed → every tile "—" plus the error string (operator surface; the reader holds the token); a
-- NULL rate → "—"; a measured value → the number. Nothing here COALESCEs a count to 0 on failure.
--
-- COST, measured 2026-10-11 ~10:35 PM PT before writing (EXPLAIN ANALYZE, BUFFERS on this body, cold
-- cache, LARGE compute): shared hit=21 read=93 — 114 buffers, 52.5 ms. Both event reads are
-- index-only scans over the 60-day window (idx_usage_events_user_time: 1,478 rows / 105 buffers;
-- funnel_events_user_id_created_idx: 57 rows / 2 buffers); auth.users is 38 rows / 3 buffers. The
-- result is aggregated in memory from ~650 activity rows. statement_timeout 8 s matches
-- get_rpc_traction_snapshot. STABLE: pure read. (A dated sample — re-measure before quoting.)
--
-- REVERT: DROP FUNCTION public.get_rpc_traction_activity(); and remove the second rpc() call from
-- app/api/admin/analytics-overview/route.ts (the client renders "—" for an absent block).

CREATE OR REPLACE FUNCTION public.get_rpc_traction_activity()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '8s'
AS $function$
  WITH internal AS (
    SELECT ia.user_id FROM public.internal_accounts ia
  ),
  accounts AS (
    SELECT u.id, u.created_at
    FROM auth.users u
    WHERE NOT EXISTS (SELECT 1 FROM internal i WHERE i.user_id = u.id)
  ),
  activity AS (
    SELECT e.user_id, e.occurred_at AS at
    FROM public.usage_events e
    WHERE e.user_id IS NOT NULL AND e.occurred_at > now() - interval '60 days'
    UNION ALL
    SELECT f.user_id, f.created_at AS at
    FROM public.funnel_events f
    WHERE f.user_id IS NOT NULL AND f.created_at > now() - interval '60 days'
  ),
  act AS (
    SELECT a.user_id, a.at
    FROM activity a
    WHERE NOT EXISTS (SELECT 1 FROM internal i WHERE i.user_id = a.user_id)
  ),
  d7_cohort AS (
    SELECT id, created_at FROM accounts
    WHERE created_at <= now() - interval '7 days' AND created_at > now() - interval '14 days'
  ),
  d7_returned AS (
    SELECT c.id FROM d7_cohort c
    WHERE EXISTS (SELECT 1 FROM act WHERE act.user_id = c.id AND act.at >= c.created_at + interval '7 days')
  ),
  d30_cohort AS (
    SELECT id, created_at FROM accounts
    WHERE created_at <= now() - interval '30 days' AND created_at > now() - interval '60 days'
  ),
  d30_returned AS (
    SELECT c.id FROM d30_cohort c
    WHERE EXISTS (SELECT 1 FROM act WHERE act.user_id = c.id AND act.at >= c.created_at + interval '30 days')
  )
  SELECT jsonb_build_object(
    'generated_at',    now(),
    'basis',           'accounts = auth.users minus internal_accounts; activity = usage_events + funnel_events rows with a user_id (anonymous activity is not counted); Dn return = accounts created n..2n days ago with any activity at or after creation + n days; a rate over an empty cohort is null',
    'accounts_total',  (SELECT count(*) FROM accounts),
    'signups_7d',      (SELECT count(*) FROM accounts WHERE created_at > now() - interval '7 days'),
    'signups_30d',     (SELECT count(*) FROM accounts WHERE created_at > now() - interval '30 days'),
    'wau',             (SELECT count(DISTINCT user_id) FROM act WHERE at > now() - interval '7 days'),
    'mau',             (SELECT count(DISTINCT user_id) FROM act WHERE at > now() - interval '30 days'),
    'd7_cohort',       (SELECT count(*) FROM d7_cohort),
    'd7_returned',     (SELECT count(*) FROM d7_returned),
    'd7_return_pct',   CASE WHEN (SELECT count(*) FROM d7_cohort) = 0 THEN NULL
                            ELSE round(100.0 * (SELECT count(*) FROM d7_returned)::numeric
                                       / (SELECT count(*) FROM d7_cohort)::numeric, 1) END,
    'd30_cohort',      (SELECT count(*) FROM d30_cohort),
    'd30_returned',    (SELECT count(*) FROM d30_returned),
    'd30_return_pct',  CASE WHEN (SELECT count(*) FROM d30_cohort) = 0 THEN NULL
                            ELSE round(100.0 * (SELECT count(*) FROM d30_returned)::numeric
                                       / (SELECT count(*) FROM d30_cohort)::numeric, 1) END
  );
$function$;

REVOKE ALL ON FUNCTION public.get_rpc_traction_activity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_rpc_traction_activity() TO service_role;

COMMENT ON FUNCTION public.get_rpc_traction_activity() IS
'Admin-only traction snapshot (service_role via /api/admin/analytics-overview): accounts_total, signups_7d/30d, WAU, MAU, D7/D30 return — all EXCLUDING internal_accounts. Accounts = auth.users; activity = usage_events + funnel_events rows carrying a user_id. A return pct over an empty cohort is NULL, never 0. Added 2026-10-11 (platform review M3) because the 100-WAU gate was unmeasurable from the product.';
