-- visitor_journeys_concierge_visit_link_returning_visitor_id
-- anon-exec: revoked (referrer_ai_source) — NEW fn; REVOKE FROM PUBLIC, anon, authenticated in one statement below, asserted with has_function_privilege.
-- anon-exec: revoked (admin_visitor_journeys) — NEW fn; REVOKE FROM PUBLIC, anon, authenticated in one statement below, asserted with has_function_privilege.
--
-- 2026-10-03 (Trevor: "How can we track these users better?" → "Do all of it").
-- Before this, a visit was four disconnected streams: usage_events (page views),
-- funnel_events (arrivals, wallet pastes), outbound_clicks and support_conversations
-- (concierge). The concierge keyed on its own chat id, so "what did this visitor do
-- before asking the concierge" was unanswerable, and rpc_sess dies with the tab, so a
-- visitor returning tomorrow was a new stranger.
--
-- OBJECTS
--   support_conversations.visit_session_id / visit_referrer  the funnel rpc_sess id +
--       landing attribution the chat widget now sends (lib/concierge/visit-link.ts)
--   funnel_events.visitor_id   rpc_vid — random first-party localStorage id, not sent
--       under GPC/DNT (lib/track-funnel.ts getVisitorId; disclosed on /privacy)
--   referrer_ai_source(text)   'chatgpt' | 'perplexity' | 'claude' | … | NULL
--   admin_visitor_journeys(hours, max_sessions)  one timeline per HUMAN visit for
--       /admin/visitor-journeys: bots (bot_ua / usage_events automated / smoke-test
--       chats) and internal_accounts sessions are EXCLUDED but COUNTED, so the board
--       states what it left out instead of silently shrinking.
--   data: support_conversations id 10308 (cowork-billing-check-20261002) → is_smoke_test.
--       The route now tags cowork-/smoke-/qa-/test-/internal- session ids itself.
--
-- REVERT:
--   DROP FUNCTION public.admin_visitor_journeys(integer, integer);
--   DROP FUNCTION public.referrer_ai_source(text);
--   DROP INDEX public.funnel_events_visitor_created_idx;
--   DROP INDEX public.idx_support_conv_visit_session;
--   ALTER TABLE public.funnel_events DROP COLUMN visitor_id;
--   ALTER TABLE public.support_conversations DROP COLUMN visit_session_id, DROP COLUMN visit_referrer;
--   UPDATE public.support_conversations SET is_smoke_test = false WHERE id = 10308;
--   (The app writes these columns; revert the app commit FIRST or every chat/funnel insert fails.)

ALTER TABLE public.support_conversations
  ADD COLUMN IF NOT EXISTS visit_session_id text,
  ADD COLUMN IF NOT EXISTS visit_referrer text;

ALTER TABLE public.funnel_events
  ADD COLUMN IF NOT EXISTS visitor_id text;

CREATE INDEX IF NOT EXISTS idx_support_conv_visit_session
  ON public.support_conversations (visit_session_id, created_at)
  WHERE visit_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS funnel_events_visitor_created_idx
  ON public.funnel_events (visitor_id, created_at)
  WHERE visitor_id IS NOT NULL;

UPDATE public.support_conversations
   SET is_smoke_test = true
 WHERE id = 10308
   AND session_id = 'cowork-billing-check-20261002'
   AND is_smoke_test IS DISTINCT FROM true;

-- The AI assistant a visit arrived from, read off the attribution string
-- lib/track-funnel.ts builds ("utm_source=chatgpt.com&ref=https://chatgpt.com/").
-- Hosts are matched at a boundary so e.g. "notclaude.ai" or "max.ai" do not match.
CREATE OR REPLACE FUNCTION public.referrer_ai_source(p_ref text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_ref IS NULL OR p_ref = '' THEN NULL
    WHEN lower(p_ref) ~ '(^|[^a-z0-9.-])(chatgpt\.com|chat\.openai\.com)' THEN 'chatgpt'
    WHEN lower(p_ref) ~ '(^|[^a-z0-9.-])(www\.)?perplexity\.ai' THEN 'perplexity'
    WHEN lower(p_ref) ~ '(^|[^a-z0-9.-])claude\.ai' THEN 'claude'
    WHEN lower(p_ref) ~ '(^|[^a-z0-9.-])(gemini|bard)\.google\.com' THEN 'gemini'
    WHEN lower(p_ref) ~ '(^|[^a-z0-9.-])copilot\.microsoft\.com' THEN 'copilot'
    WHEN lower(p_ref) ~ '(^|[^a-z0-9.-])(chat\.)?deepseek\.com' THEN 'deepseek'
    WHEN lower(p_ref) ~ '(^|[^a-z0-9.-])(grok\.com|x\.ai)' THEN 'grok'
    WHEN lower(p_ref) ~ '(^|[^a-z0-9.-])meta\.ai' THEN 'meta_ai'
    WHEN lower(p_ref) ~ '(^|[^a-z0-9.-])(you\.com|phind\.com)' THEN 'other_ai'
    ELSE NULL
  END
$$;

REVOKE EXECUTE ON FUNCTION public.referrer_ai_source(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.referrer_ai_source(text) TO service_role;

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
  SELECT public.referrer_ai_source(fe.referrer) AS source, count(DISTINCT fe.session_id) AS sessions
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
    SELECT jsonb_agg(jsonb_build_object('source', ai_source, 'sessions', n) ORDER BY n DESC)
      FROM (SELECT ai_source, count(*) AS n FROM human WHERE ai_source IS NOT NULL GROUP BY ai_source) x
  ), '[]'::jsonb),
  'ai_referrals_30d', coalesce((
    SELECT jsonb_agg(jsonb_build_object('source', source, 'sessions', sessions) ORDER BY sessions DESC) FROM ai30
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

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.admin_visitor_journeys(integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admin_visitor_journeys(integer, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.referrer_ai_source(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'visitor-journeys functions must not be executable by anon/authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.admin_visitor_journeys(integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on admin_visitor_journeys';
  END IF;
END
$$;
