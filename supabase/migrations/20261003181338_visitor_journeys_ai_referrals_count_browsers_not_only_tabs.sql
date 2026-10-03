-- visitor_journeys_ai_referrals_count_browsers_not_only_tabs
-- anon-exec: unchanged (admin_visitor_journeys) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (service_role only), re-asserted below.
--
-- 2026-10-03. The AI-referral counts on /admin/visitor-journeys were SESSIONS, and a session is a
-- TAB (rpc_sess is sessionStorage). An assistant opens every link it cites in a new tab, so one
-- person reading five answers is five "sessions": 09-17's 29 ChatGPT sessions came from 4 user
-- agents across ~20 edition pages; 09-20's 12 from 2. The 30-day "84 ChatGPT sessions" is not 84
-- people. Both AI-referral lists now also carry `browsers` = distinct rpc_vid where the visit has
-- one (visitor ids exist since 2026-10-03), else the session — an UPPER bound on people that
-- tightens as ids accumulate. `sessions` is unchanged.
--
-- Base verified: live prosrc md5 a44f75eec4dd18f307f35e4e0e7e0245 == the 20261003150031 body.
-- Pin: supabase/tests/admin_visitor_journeys.sql (claim 5).
-- REVERT: re-apply admin_visitor_journeys from
--   supabase/migrations/20261003150031_visitor_journeys_concierge_visit_link_returning_visitor_id.sql

CREATE OR REPLACE FUNCTION public.admin_visitor_journeys(
  p_hours integer DEFAULT 24,
  p_max_sessions integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH win AS (
  SELECT now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 168)) AS since,
         least(greatest(coalesce(p_max_sessions, 60), 1), 300) AS max_sessions
),
ev AS (
  SELECT fe.session_id AS sid, fe.created_at AS at, 'funnel'::text AS src, fe.event_type AS kind,
         fe.surface AS detail, fe.referrer AS ref, fe.user_id, fe.wallet_address AS wallet,
         fe.visitor_id AS vid, coalesce(fe.bot_ua, false) AS bot
    FROM funnel_events fe, win
   WHERE fe.created_at >= win.since AND fe.session_id IS NOT NULL
  UNION ALL
  SELECT ue.metadata->>'sid', ue.occurred_at, 'usage', ue.feature_name,
         ue.metadata->>'path', ue.metadata->>'ref', ue.user_id,
         CASE WHEN ue.wallet_address ~* '^0x[0-9a-f]+$' THEN ue.wallet_address END,
         ue.metadata->>'vid', (ue.metadata->>'automated') = 'true'
    FROM usage_events ue, win
   WHERE ue.occurred_at >= win.since AND ue.metadata ? 'sid'
  UNION ALL
  SELECT oc.session_id, oc.created_at, 'click', coalesce(oc.link_kind, 'outbound'),
         concat_ws(' → ', oc.surface, coalesce(oc.player_name, oc.destination)), NULL, oc.user_id,
         oc.wallet_address, NULL, coalesce(oc.bot_ua, false)
    FROM outbound_clicks oc, win
   WHERE oc.created_at >= win.since AND oc.session_id IS NOT NULL
  UNION ALL
  SELECT sc.visit_session_id, sc.created_at, 'concierge', coalesce(sc.category, 'chat'),
         left(sc.user_message, 200), sc.visit_referrer, NULL, sc.user_wallet, NULL,
         coalesce(sc.is_smoke_test, false)
    FROM support_conversations sc, win
   WHERE sc.created_at >= win.since AND sc.visit_session_id IS NOT NULL
),
sess AS (
  SELECT e.sid,
         min(e.at) AS first_at,
         max(e.at) AS last_at,
         count(*) AS n_events,
         bool_or(e.bot) AS any_bot,
         bool_or(ia.user_id IS NOT NULL) AS internal,
         max(e.vid) AS vid,
         (array_agg(e.ref ORDER BY e.at) FILTER (WHERE e.ref IS NOT NULL AND e.ref <> ''))[1] AS landing_ref,
         (array_agg(e.detail ORDER BY e.at) FILTER (WHERE e.detail IS NOT NULL AND e.src IN ('usage', 'funnel')))[1] AS landing_path,
         max(e.wallet) AS wallet,
         bool_or(e.user_id IS NOT NULL) AS signed_in,
         bool_or(e.src = 'concierge') AS chatted,
         bool_or(e.kind = 'wallet_paste') AS pasted,
         bool_or(e.kind = 'email_capture_submitted') AS captured,
         bool_or(e.src = 'click') AS clicked_out
    FROM ev e
    LEFT JOIN internal_accounts ia ON ia.user_id = e.user_id
   GROUP BY e.sid
),
human AS (
  SELECT s.*,
         public.referrer_ai_source(s.landing_ref) AS ai_source,
         EXISTS (
           SELECT 1 FROM funnel_events p
            WHERE s.vid IS NOT NULL
              AND p.visitor_id = s.vid
              AND p.created_at < s.first_at
              AND p.created_at >= s.first_at - interval '30 days'
              AND p.session_id IS DISTINCT FROM s.sid
         ) AS is_returning
    FROM sess s
   WHERE NOT s.any_bot AND NOT s.internal
),
picked AS (
  SELECT h.* FROM human h, win ORDER BY h.last_at DESC LIMIT (SELECT max_sessions FROM win)
),
ai30 AS (
  -- sessions = tabs: an assistant opens every link in a NEW tab, and rpc_sess is per tab, so one
  -- person reading five answers is five sessions (09-17: 29 sessions from 4 UAs). browsers =
  -- distinct rpc_vid where the visit carries one (since 2026-10-03), else the session -- an UPPER
  -- bound on people that tightens as visitor ids accumulate.
  SELECT public.referrer_ai_source(fe.referrer) AS source, count(DISTINCT fe.session_id) AS sessions,
         count(DISTINCT coalesce(fe.visitor_id, fe.session_id)) AS browsers
    FROM funnel_events fe
   WHERE fe.created_at >= now() - interval '30 days'
     AND fe.bot_ua = false
     AND fe.referrer IS NOT NULL
     AND public.referrer_ai_source(fe.referrer) IS NOT NULL
   GROUP BY 1
)
SELECT jsonb_build_object(
  'generated_at', now(),
  'window_hours', least(greatest(coalesce(p_hours, 24), 1), 168),
  'totals', jsonb_build_object(
    'sessions_seen', (SELECT count(*) FROM sess),
    'sessions_human', (SELECT count(*) FROM human),
    'sessions_excluded_bot', (SELECT count(*) FROM sess WHERE any_bot),
    'sessions_excluded_internal', (SELECT count(*) FROM sess WHERE internal AND NOT any_bot),
    'sessions_shown', (SELECT count(*) FROM picked),
    'with_concierge', (SELECT count(*) FROM human WHERE chatted),
    'with_wallet_paste', (SELECT count(*) FROM human WHERE pasted),
    'with_email_capture', (SELECT count(*) FROM human WHERE captured),
    'signed_in', (SELECT count(*) FROM human WHERE signed_in),
    'returning', (SELECT count(*) FROM human WHERE is_returning),
    'with_visitor_id', (SELECT count(*) FROM human WHERE vid IS NOT NULL),
    'from_ai', (SELECT count(*) FROM human WHERE ai_source IS NOT NULL)
  ),
  'ai_referrals_window', coalesce((
    SELECT jsonb_agg(jsonb_build_object('source', ai_source, 'sessions', n, 'browsers', nb) ORDER BY n DESC)
      FROM (SELECT ai_source, count(*) AS n, count(DISTINCT coalesce(vid, sid)) AS nb
              FROM human WHERE ai_source IS NOT NULL GROUP BY ai_source) x
  ), '[]'::jsonb),
  'ai_referrals_30d', coalesce((
    SELECT jsonb_agg(jsonb_build_object('source', source, 'sessions', sessions, 'browsers', browsers) ORDER BY sessions DESC) FROM ai30
  ), '[]'::jsonb),
  'sessions', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'sid', p.sid,
             'visitor_id', p.vid,
             'returning', p.is_returning,
             'first_at', p.first_at,
             'last_at', p.last_at,
             'n_events', p.n_events,
             'landing_ref', p.landing_ref,
             'ai_source', p.ai_source,
             'landing_path', p.landing_path,
             'wallet', p.wallet,
             'signed_in', p.signed_in,
             'chatted', p.chatted,
             'pasted', p.pasted,
             'captured', p.captured,
             'clicked_out', p.clicked_out,
             'events', (
               SELECT jsonb_agg(jsonb_build_object('at', t.at, 'src', t.src, 'kind', t.kind, 'detail', left(t.detail, 160)) ORDER BY t.at)
                 FROM (SELECT e.* FROM ev e WHERE e.sid = p.sid ORDER BY e.at LIMIT 80) t
             )
           ) ORDER BY p.last_at DESC)
      FROM picked p
  ), '[]'::jsonb)
)
$$;

REVOKE EXECUTE ON FUNCTION public.admin_visitor_journeys(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_visitor_journeys(integer, integer) TO service_role;
