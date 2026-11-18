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
--   edition prompt       the signed-out "Own this …?" prompt on edition pages (every collection
--                        from 2026-11-16): shows (usage_events anon-value-cta-shown) vs clicks
--                        (funnel_events signin_click, surface <collection>_edition_signup).
--                        Shows count distinct HUMAN browsers and those with 2+ pages (the
--                        Panini crawler is one lone page per fresh visitor id).
--   feature use          browsers · events for the features instrumented 11-15/16: owner share
--                        clicks, edition Watch, reward card, Fill with my top 6, serial search
--                        (#12359), open offers (#12361), and the edition prompt's no-account look-up
--                        (anon-value-lookup, 11-17), and the binder's signed-out "Is this your collection?"
--                        card (anon-save-cta-shown; its clicks are funnel_events signin_click
--                        surface binder_save_signup, row 9's sign-in read)
--   wallet search outcome collection-page wallet searches by result (search-result, 11-16):
--                        loaded with moments · loaded empty · failed read
--   save vs follow       the "Is @handle your wallet?" confirm (shown · yes · cancel) and wallet
--                        Follow clicks (follow · unfollow), per surface (11-16). A high cancel
--                        share = people were about to save a wallet that wasn't theirs.
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
UNION ALL SELECT '9 signin clicks (share / binder save) · ' || coalesce(f.surface, '?'), count(*)::text
  FROM funnel_events f, params p
  WHERE f.event_type = 'signin_click' AND f.surface IN ('share_hero', 'share_cta', 'binder_save_signup')
    AND f.created_at >= p.s AND f.created_at < p.e AND NOT coalesce(f.bot_ua, false)
  GROUP BY f.surface
-- 10: distinct human browsers shown the prompt (automated = our own Playwright/axe runs, 25 of
-- the first 31 shows on 11-16), and how many of them viewed 2+ pages. The Panini crawler is
-- one lone page per fresh visitor id, so only the 2+ column says a person saw it.
UNION ALL SELECT '10 edition prompt shown (browsers · 2+ pages) · ' || coalesce(x.surface, '?'),
       count(*)::text || ' · ' || count(*) FILTER (WHERE x.pages >= 2)::text
  FROM (
    SELECT DISTINCT ue.metadata->>'surface' AS surface, ue.metadata->>'vid' AS vid,
           (SELECT count(*) FROM usage_events pv
             WHERE pv.feature_name = 'page-view' AND pv.metadata->>'vid' = ue.metadata->>'vid'
               AND pv.occurred_at >= p.s AND pv.occurred_at < p.e) AS pages
      FROM usage_events ue, params p
     WHERE ue.feature_name = 'anon-value-cta-shown' AND ue.occurred_at >= p.s AND ue.occurred_at < p.e
       AND coalesce(ue.metadata->>'automated', 'false') <> 'true'
  ) x
  GROUP BY x.surface
UNION ALL SELECT '11 edition prompt clicks · ' || coalesce(f.surface, '?'), count(*)::text
  FROM funnel_events f, params p
  WHERE f.event_type = 'signin_click' AND f.surface LIKE '%\_edition\_signup'
    AND f.created_at >= p.s AND f.created_at < p.e AND NOT coalesce(f.bot_ua, false)
  GROUP BY f.surface
-- 12: uptake of the features instrumented 11-15/11-16 (humans; internal accounts excluded)
UNION ALL SELECT '12 feature use (browsers · events) · ' || ue.feature_name,
       count(DISTINCT coalesce(ue.user_id::text, ue.metadata->>'vid'))::text || ' · ' || count(*)::text
  FROM usage_events ue, params p
  WHERE ue.occurred_at >= p.s AND ue.occurred_at < p.e
    AND ue.feature_name IN ('share-click', 'watch-edition-open', 'watch-edition-signin-needed', 'watch-edition-saved',
                            'reward-claim-card-shown', 'reward-claim-card-click', 'main-fill-click', 'main-fill-declined',
                            'main-fill-pinned', 'serial-search', 'open-offers-shown', 'offers-tab',
                            'anon-value-lookup', 'anon-save-cta-shown')
    AND coalesce(ue.metadata->>'automated', 'false') <> 'true'
    AND (ue.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_accounts ia WHERE ia.user_id = ue.user_id))
  GROUP BY ue.feature_name
-- 13: wallet searches on the collection pages, by outcome (from 2026-11-16): a failed read and a
-- wallet that loaded EMPTY were both invisible before (search-executed fires before the load)
UNION ALL SELECT '13 wallet search outcome (loaded · empty · failed) · ' || coalesce(ue.metadata->>'collection', '?'),
       count(*) FILTER (WHERE ue.metadata->>'ok' = 'true' AND (ue.metadata->>'total')::numeric > 0)::text || ' · ' ||
       count(*) FILTER (WHERE ue.metadata->>'ok' = 'true' AND (ue.metadata->>'total')::numeric = 0)::text || ' · ' ||
       count(*) FILTER (WHERE ue.metadata->>'ok' = 'false')::text
  FROM usage_events ue, params p
  WHERE ue.occurred_at >= p.s AND ue.occurred_at < p.e AND ue.feature_name = 'search-result'
    AND coalesce(ue.metadata->>'automated', 'false') <> 'true'
    AND (ue.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_accounts ia WHERE ia.user_id = ue.user_id))
  GROUP BY ue.metadata->>'collection'
-- 14: save-as-mine confirm and wallet Follow (from 2026-11-16), per surface (binder | share).
-- ⚠ track() coalesces one feature name per 350 ms, so a step undone faster than that is lost.
UNION ALL SELECT '14 own-wallet confirm (shown · yes · cancel) · ' || coalesce(ue.metadata->>'surface', '?'),
       count(*) FILTER (WHERE ue.metadata->>'step' = 'shown')::text || ' · ' ||
       count(*) FILTER (WHERE ue.metadata->>'step' = 'yes')::text || ' · ' ||
       count(*) FILTER (WHERE ue.metadata->>'step' = 'cancel')::text
  FROM usage_events ue, params p
  WHERE ue.occurred_at >= p.s AND ue.occurred_at < p.e AND ue.feature_name = 'own-wallet-confirm'
    AND coalesce(ue.metadata->>'automated', 'false') <> 'true'
    AND (ue.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_accounts ia WHERE ia.user_id = ue.user_id))
  GROUP BY ue.metadata->>'surface'
UNION ALL SELECT '14 wallet follow (follow · unfollow) · ' || coalesce(ue.metadata->>'surface', '?'),
       count(*) FILTER (WHERE ue.metadata->>'on' = 'true')::text || ' · ' ||
       count(*) FILTER (WHERE ue.metadata->>'on' = 'false')::text
  FROM usage_events ue, params p
  WHERE ue.occurred_at >= p.s AND ue.occurred_at < p.e AND ue.feature_name = 'wallet-follow'
    AND coalesce(ue.metadata->>'automated', 'false') <> 'true'
    AND (ue.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_accounts ia WHERE ia.user_id = ue.user_id))
  GROUP BY ue.metadata->>'surface'
ORDER BY 1;
