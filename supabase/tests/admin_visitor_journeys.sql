-- DB invariant: public.admin_visitor_journeys + public.referrer_ai_source — the
-- /admin/visitor-journeys board (2026-10-03). Claims:
--
--   1. A visit's rows from all four streams (funnel_events, usage_events with
--      metadata.sid, outbound_clicks, support_conversations.visit_session_id)
--      join into ONE session, events in time order.
--   2. Bot sessions (funnel bot_ua / usage automated / smoke-test chat) and
--      internal_accounts sessions are EXCLUDED from sessions[] but COUNTED in
--      totals — the board says what it left out instead of silently shrinking.
--   3. A visitor_id seen in an EARLIER session within 30 days marks the visit
--      returning; one seen only longer ago, or never, does not.
--   5. AI-referral lists count SESSIONS (tabs) and BROWSERS (distinct visitor id, else session):
--      two ChatGPT tabs from one browser are 2 sessions, 1 browser.
--   4. referrer_ai_source classifies the attribution string by host at a
--      boundary: chatgpt / perplexity / claude; a look-alike host does not match.
--
-- The function DDL below is VERBATIM from the committed migration
-- (admin_visitor_journeys: supabase/migrations/20261003181338_visitor_journeys_ai_referrals_count_browsers_not_only_tabs.sql;
-- referrer_ai_source: supabase/migrations/20261003150031_visitor_journeys_concierge_visit_link_returning_visitor_id.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.funnel_events (id bigserial, event_type text, wallet_address text, session_id text, surface text, referrer text, created_at timestamptz, user_agent text, bot_ua boolean, user_id uuid, visitor_id text);
CREATE TABLE public.usage_events (id bigserial, wallet_address text, user_id uuid, feature_name text, metadata jsonb, occurred_at timestamptz);
CREATE TABLE public.outbound_clicks (id bigserial, created_at timestamptz, surface text, destination text, player_name text, wallet_address text, session_id text, link_kind text, user_id uuid, bot_ua boolean);
CREATE TABLE public.support_conversations (id bigserial, session_id text, user_message text, category text, user_wallet text, is_smoke_test boolean, created_at timestamptz, visit_session_id text, visit_referrer text);
CREATE TABLE public.internal_accounts (user_id uuid PRIMARY KEY, reason text);

-- >>> BEGIN verbatim >>>
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
-- <<< END verbatim <<<

INSERT INTO public.internal_accounts VALUES ('00000000-0000-0000-0000-00000000000f', 'founder');

-- human visit H: ChatGPT arrival, page view, paste, concierge chat, outbound click
INSERT INTO public.funnel_events (event_type, wallet_address, session_id, surface, referrer, created_at, bot_ua, visitor_id) VALUES
  ('collection_view', NULL, 'H', '/nba-top-shot/collection', 'utm_source=chatgpt.com&ref=https://chatgpt.com/', now() - interval '50 min', false, 'V1'),
  ('wallet_paste', '0xabc', 'H', 'home', 'utm_source=chatgpt.com&ref=https://chatgpt.com/', now() - interval '40 min', false, 'V1'),
  -- an EARLIER visit by the same browser (claim 3) — outside the 24h window
  ('home_view', NULL, 'OLD', '/', NULL, now() - interval '3 days', false, 'V1'),
  -- a visitor with no earlier visit: G is not returning
  ('home_view', NULL, 'G', '/', NULL, now() - interval '30 min', false, 'V2'),
  -- V3's only earlier visit is 40 days old: outside the 30-day lookback, so R is NOT returning
  ('home_view', NULL, 'OLD40', '/', NULL, now() - interval '40 days', false, 'V3'),
  ('home_view', NULL, 'R', '/', NULL, now() - interval '25 min', false, 'V3'),
  -- claim 5: one browser (V9) opened two ChatGPT links 3 days ago, in two tabs
  ('collection_view', NULL, 'C1', '/nba-top-shot/edition/1:1', 'utm_source=chatgpt.com', now() - interval '3 days', false, 'V9'),
  ('collection_view', NULL, 'C2', '/nba-top-shot/edition/1:2', 'utm_source=chatgpt.com', now() - interval '3 days' + interval '2 min', false, 'V9'),
  -- bot B, internal I
  ('home_view', NULL, 'B', '/', NULL, now() - interval '20 min', true, NULL),
  ('home_view', NULL, 'I', '/', NULL, now() - interval '20 min', false, NULL);
UPDATE public.funnel_events SET user_id = '00000000-0000-0000-0000-00000000000f' WHERE session_id = 'I';
INSERT INTO public.usage_events (wallet_address, feature_name, metadata, occurred_at) VALUES
  ('anon', 'page-view', '{"path":"/share/0xabc","sid":"H","vid":"V1"}', now() - interval '39 min'),
  ('anon', 'page-view', '{"path":"/","sid":"A","automated":true}', now() - interval '10 min');
INSERT INTO public.outbound_clicks (created_at, surface, destination, session_id, link_kind, bot_ua) VALUES
  (now() - interval '35 min', 'sniper', 'https://nbatopshot.com/x', 'H', 'buy', false);
INSERT INTO public.support_conversations (session_id, user_message, category, is_smoke_test, created_at, visit_session_id, visit_referrer) VALUES
  ('rpc_1', 'what is my collection worth', 'general', false, now() - interval '38 min', 'H', 'utm_source=chatgpt.com'),
  ('smoke-1', 'ping', 'general', true, now() - interval '5 min', 'S', NULL);

DO $$
DECLARE v jsonb; h jsonb;
BEGIN
  v := public.admin_visitor_journeys(24, 60);
  PERFORM _assert_eq((v->'totals'->>'sessions_seen'), '7', 'H, G, R, B, I, A, S all seen (claim 2)');
  PERFORM _assert_eq((v->'totals'->>'sessions_human'), '3', 'only H, G and R are human (claim 2)');
  PERFORM _assert_eq((v->'totals'->>'sessions_excluded_bot'), '3', 'bot_ua, automated usage, smoke chat excluded (claim 2)');
  PERFORM _assert_eq((v->'totals'->>'sessions_excluded_internal'), '1', 'internal account excluded (claim 2)');
  PERFORM _assert_eq((SELECT string_agg(e->>'sid', ',' ORDER BY e->>'sid') FROM jsonb_array_elements(v->'sessions') e), 'G,H,R', 'sessions[] holds only the humans (claim 2)');
  h := (SELECT e FROM jsonb_array_elements(v->'sessions') e WHERE e->>'sid' = 'H');
  PERFORM _assert_eq((SELECT string_agg(x->>'src' || ':' || (x->>'kind'), ',' ORDER BY o) FROM jsonb_array_elements(h->'events') WITH ORDINALITY t(x, o)),
                     'funnel:collection_view,funnel:wallet_paste,usage:page-view,concierge:general,click:buy',
                     'all four streams join into one visit, in time order (claim 1)');
  PERFORM _assert((h->>'chatted')::boolean AND (h->>'pasted')::boolean AND (h->>'clicked_out')::boolean, 'H flags (claim 1)');
  PERFORM _assert_eq(h->>'ai_source', 'chatgpt', 'landing attribution classified (claim 4)');
  PERFORM _assert_eq(h->>'wallet', '0xabc', 'pasted wallet surfaced');
  PERFORM _assert_eq(h->>'returning', 'true', 'V1 was seen in an earlier session (claim 3)');
  PERFORM _assert_eq((SELECT e->>'returning' FROM jsonb_array_elements(v->'sessions') e WHERE e->>'sid' = 'G'), 'false', 'V2 has no earlier session (claim 3)');
  PERFORM _assert_eq((SELECT e->>'returning' FROM jsonb_array_elements(v->'sessions') e WHERE e->>'sid' = 'R'), 'false', 'an earlier visit 40 days back is outside the lookback (claim 3)');
  PERFORM _assert_eq(v->'ai_referrals_window'->0->>'source', 'chatgpt', 'AI referral board (claim 4)');
  PERFORM _assert_eq((v->'ai_referrals_window'->0->>'sessions') || '/' || (v->'ai_referrals_window'->0->>'browsers'), '1/1',
                     'window: H is one session, one browser (claim 5)');
  PERFORM _assert_eq((v->'ai_referrals_30d'->0->>'sessions') || '/' || (v->'ai_referrals_30d'->0->>'browsers'), '3/2',
                     '30 d: H + two V9 tabs = 3 sessions but 2 browsers (claim 5)');

  PERFORM _assert_eq(public.referrer_ai_source('ref=https://www.perplexity.ai/search'), 'perplexity', 'perplexity (claim 4)');
  PERFORM _assert_eq(public.referrer_ai_source('ref=https://claude.ai/chat/x'), 'claude', 'claude (claim 4)');
  PERFORM _assert_eq(public.referrer_ai_source('ref=https://notclaude.ai/'), NULL, 'look-alike host does not match (claim 4)');
  PERFORM _assert_eq(public.referrer_ai_source('ref=https://max.ai/'), NULL, 'x.ai only at a boundary (claim 4)');
  PERFORM _assert_eq(public.referrer_ai_source('utm_source=share&share_ref=abc'), NULL, 'non-AI attribution (claim 4)');
  PERFORM _assert_eq(public.referrer_ai_source(NULL), NULL, 'null');
END $$;

ROLLBACK;
