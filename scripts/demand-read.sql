-- scripts/demand-read.sql — the weekly DEMAND READ, codified 2026-10-22 (Claude Code cloud) from the
-- 10-15 baseline block in docs/reference/roadmap-status.md ("DEMAND READ, WEEK OF 10-08..10-14 PT").
-- Before this file the method was prose only, so a re-read could not be told apart from a re-definition.
--
-- RUN: edit the two timestamps in `params` (a PT week = 07:00 UTC Thursday → 07:00 UTC next Thursday
-- while PDT holds; 08:00 UTC after the November switch) and run read-only (MCP execute_sql / psql).
-- One row per metric. Re-run on the baseline week (10-08..10-14) it matches the hand-counted 10-15 block
-- on browsers 61, signed-in 6, direct 60, ChatGPT 4, email prompt 16 (7 browsers); it differs on visits
-- 88 (block ~94), Google 24 / 18 one-page (block 26 / 19) and wallet pastes 27 events (block "10" — its
-- counting rule was never written down). COMPARE SCRIPT AGAINST SCRIPT: re-run the prior week with this
-- file, never quote the prose block as the baseline.
--
-- DEFINITIONS (each one is a choice; change it here, never in a one-off query):
--   human event  = usage_events minus metadata.automated = 'true'.
--   HUMAN VISIT  = a metadata.sid that has a `vid` AND at least one page-view. This is the discount for
--                  the UNFLAGGED headless fingerprint (schema-truth.md: no vid, a fresh sid per page, no
--                  page-view beside its client_error) — it passes the client `automated` check.
--   browser      = distinct metadata.vid among human visits.
--   source       = the `ref` of the visit's FIRST page-view: google / chatgpt (utm_source or ref) / bing /
--                  x (t.co or utm_medium=x) / other ref / direct (no ref).
--   one-page     = a visit with exactly one page-view.
--   signed-in    = distinct user_id on human events, minus user_activity.is_internal (internal_accounts
--                  by user id AND the founder's wallet-keyed rows — matching user_id alone misses them).
--   funnel       = wallet paste (search-executed with metadata.input_kind address|username) → share view
--                  (DISTINCT browser × /share/% page — raw page-view events were inflated by the share
--                  empty-state reload loop fixed 2026-10-22: one browser logged 36 in 6 min) → sign-in click.
--   ⚠ SIGN-IN CLICKS LIVE IN funnel_events (lib/track-funnel.ts → /api/track-funnel), NOT usage_events:
--                  the 10-15 block and the 10-22 night pass both read usage_events and reported 0. Counted
--                  where bot_ua is false, by surface.
--   email prompt = deal-watch-shown (10-14 and before) + first-alert-prompt-shown (dashboard card, 10-14+).
WITH params AS (
  SELECT timestamptz '2026-10-15 07:00+00' AS s, timestamptz '2026-10-22 07:00+00' AS e
), ev AS (
  SELECT u.* FROM usage_events u, params p
  WHERE u.occurred_at >= p.s AND u.occurred_at < p.e
    AND coalesce(u.metadata->>'automated', 'false') <> 'true'
), visits AS (
  SELECT metadata->>'sid' AS sid, min(metadata->>'vid') AS vid,
         count(*) FILTER (WHERE feature_name = 'page-view') AS pv,
         (array_agg(metadata->>'ref' ORDER BY occurred_at) FILTER (WHERE feature_name = 'page-view'))[1] AS ref,
         (array_agg(metadata->>'path' ORDER BY occurred_at) FILTER (WHERE feature_name = 'page-view'))[1] AS landing
  FROM ev WHERE metadata ? 'sid'
  GROUP BY 1
  HAVING min(metadata->>'vid') IS NOT NULL AND count(*) FILTER (WHERE feature_name = 'page-view') > 0
), src AS (
  SELECT v.*, CASE
      WHEN ref IS NULL THEN 'direct'
      WHEN ref ILIKE '%google.%' THEN 'google'
      WHEN ref ILIKE '%chatgpt%' THEN 'chatgpt'
      WHEN ref ILIKE '%bing.com%' THEN 'bing'
      WHEN ref ILIKE '%t.co/%' OR ref ILIKE '%utm_medium=x%' THEN 'x'
      ELSE 'other' END AS source
  FROM visits v
), signed AS (
  SELECT DISTINCT ua.user_id FROM user_activity ua JOIN ev ON ev.id = ua.id
  WHERE ua.user_id IS NOT NULL AND NOT coalesce(ua.is_internal, false)
)
SELECT 'human events' AS metric, count(*)::text AS value FROM ev
UNION ALL SELECT 'browsers', count(DISTINCT vid)::text FROM visits
UNION ALL SELECT 'visits', count(*)::text FROM visits
UNION ALL SELECT 'external signed-in users', count(*)::text FROM signed
UNION ALL SELECT 'source: ' || source, count(*)::text || ' visits (' || count(*) FILTER (WHERE pv = 1) || ' one-page)' FROM src GROUP BY source
UNION ALL SELECT 'funnel: wallet pastes', count(*)::text || ' (' || count(DISTINCT metadata->>'vid') || ' browsers)' FROM ev WHERE feature_name = 'search-executed' AND metadata->>'input_kind' IN ('address', 'username')
UNION ALL SELECT 'funnel: share views (browser × page)', count(DISTINCT (metadata->>'vid') || '|' || (metadata->>'path'))::text || ' (' || count(*) || ' raw page-view events)' FROM ev WHERE feature_name = 'page-view' AND metadata->>'path' LIKE '/share/%'
UNION ALL SELECT 'funnel: sign-in clicks · ' || coalesce(f.surface, '?'), count(*)::text
  FROM funnel_events f, params p
  WHERE f.event_type = 'signin_click' AND f.created_at >= p.s AND f.created_at < p.e AND NOT coalesce(f.bot_ua, false)
  GROUP BY f.surface
UNION ALL SELECT 'email prompt shown', count(*)::text || ' (' || count(DISTINCT metadata->>'vid') || ' browsers)' FROM ev WHERE feature_name IN ('deal-watch-shown', 'first-alert-prompt-shown')
UNION ALL SELECT 'magic-link-requested', count(*)::text FROM ev WHERE feature_name = 'magic-link-requested'
UNION ALL SELECT 'signups (auth.users created, minus internal)', count(*)::text
  FROM auth.users au, params p
  WHERE au.created_at >= p.s AND au.created_at < p.e
    AND NOT EXISTS (SELECT 1 FROM internal_accounts ia WHERE ia.user_id = au.id)
UNION ALL SELECT 'event: ' || feature_name, count(*)::text FROM ev GROUP BY feature_name
ORDER BY 1;
