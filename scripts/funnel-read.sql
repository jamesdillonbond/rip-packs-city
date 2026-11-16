-- scripts/funnel-read.sql — the signup → activation → return funnel (2026-11-16)
--
-- Companion to scripts/demand-read.sql (traffic) for the weekly activity review.
-- Paste into the Supabase SQL editor or run via the MCP execute_sql. Change the
-- window in `params`; s/e are UTC instants (PT midnight = 08:00 UTC in PST,
-- 07:00 UTC in PDT). Internal accounts are excluded everywhere.
--
-- What each row means:
--   signups              auth.users created in the window
--   saved_wallet         … with any saved_wallets row now
--   returned_2nd_day     … with usage events on ≥ 2 distinct PT dates (ever)
--   active_3plus_days    … on ≥ 3 PT dates
--   made_trophy_case     … with any trophy_cases row
--   day1_email_sent      day1_onboarding alert_deliveries rows status 'sent' in the window
--   day1_then_returned   … whose account has a usage event in the 3 days after the send
--   share signin clicks  funnel_events signin_click by surface: share_hero (under the
--                        value, from 2026-11-16) vs share_cta (bottom of the card)
--   share viewers        signed-out browsers that viewed a /share/<wallet> card
--
-- Traps (measured 2026-11-16):
--   * magic-link-requested browsers that "never signed in" are NOT lost signups:
--     auth.users has never held an unconfirmed account, so every new email that
--     requested a link clicked it. The gap is members opening the link on another
--     device (a new visitor id). Don't count it as funnel loss.
--   * Signed-out traffic needs demand-read.sql's crawler rule; this file reads
--     accounts and their events, which crawlers do not create.

WITH params AS (
  SELECT timestamptz '2026-11-09 08:00+00' AS s, now() AS e
), u AS (
  SELECT au.id, au.created_at
  FROM auth.users au, params p
  WHERE au.created_at >= p.s AND au.created_at < p.e
    AND NOT EXISTS (SELECT 1 FROM internal_accounts ia WHERE ia.user_id = au.id)
), w AS (
  SELECT DISTINCT sw.user_id FROM saved_wallets sw WHERE sw.user_id IN (SELECT id FROM u)
), d AS (
  SELECT ue.user_id, count(DISTINCT (ue.occurred_at AT TIME ZONE 'America/Los_Angeles')::date) AS days
  FROM usage_events ue WHERE ue.user_id IN (SELECT id FROM u) GROUP BY 1
), tc AS (
  SELECT DISTINCT user_id FROM trophy_cases WHERE user_id IN (SELECT id FROM u)
), sent AS (
  SELECT ad.owner_key, min(ad.created_at) AS sent_at
  FROM alert_deliveries ad, params p
  WHERE ad.alert_kind = 'day1_onboarding' AND ad.status = 'sent'
    AND ad.created_at >= p.s AND ad.created_at < p.e
  GROUP BY 1
), sent_ret AS (
  SELECT s.owner_key FROM sent s
  WHERE EXISTS (
    SELECT 1 FROM usage_events ue
    WHERE ue.user_id::text = s.owner_key AND ue.occurred_at > s.sent_at AND ue.occurred_at < s.sent_at + interval '3 days'
  )
), share_views AS (
  SELECT count(DISTINCT ue.metadata->>'vid') AS n
  FROM usage_events ue, params p
  WHERE ue.occurred_at >= p.s AND ue.occurred_at < p.e AND ue.feature_name = 'page-view'
    AND ue.metadata->>'path' LIKE '/share/%' AND ue.user_id IS NULL
    AND coalesce(ue.metadata->>'automated', 'false') <> 'true'
)
SELECT '1 signups' AS metric, count(*)::text AS value FROM u
UNION ALL SELECT '2 saved_wallet', count(*)::text FROM u WHERE id IN (SELECT user_id FROM w)
UNION ALL SELECT '3 returned_2nd_day', count(*)::text FROM u JOIN d ON d.user_id = u.id WHERE d.days >= 2
UNION ALL SELECT '4 active_3plus_days', count(*)::text FROM u JOIN d ON d.user_id = u.id WHERE d.days >= 3
UNION ALL SELECT '5 made_trophy_case', count(*)::text FROM u WHERE id IN (SELECT user_id FROM tc)
UNION ALL SELECT '6 day1_email_sent', count(*)::text FROM sent
UNION ALL SELECT '7 day1_then_returned_within_3d', count(*)::text FROM sent_ret
UNION ALL SELECT '8 share viewers (signed out)', n::text FROM share_views
UNION ALL SELECT '9 share signin clicks · ' || coalesce(f.surface, '?'), count(*)::text
  FROM funnel_events f, params p
  WHERE f.event_type = 'signin_click' AND f.surface IN ('share_hero', 'share_cta')
    AND f.created_at >= p.s AND f.created_at < p.e AND NOT coalesce(f.bot_ua, false)
  GROUP BY f.surface
ORDER BY 1;
