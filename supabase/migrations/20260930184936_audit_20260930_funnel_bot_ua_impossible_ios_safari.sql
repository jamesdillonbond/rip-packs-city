-- audit_20260930_funnel_bot_ua_impossible_ios_safari
--
-- Backfills funnel_events.bot_ua for the rule added to lib/bot-ua.ts the same
-- day: an iOS token BELOW 18 paired with Safari Version 26+ is a pairing no
-- real device sends (Safari 26 runs only on iOS 26, whose UA is frozen at
-- "iPhone OS 18_x"). It is Playwright's devices["iPhone 13"] descriptor —
-- our own scripts/qa/mobile-sweep.mjs plus Playwright-built crawlers.
--
-- Measured before applying (2026-09-30, rows since the column landed
-- 2026-08-23 02:00Z): 1,408 rows / 1,398 sessions, ONE distinct UA
-- ("iPhone OS 15_0 … Version/26.5"), 0 rows with a user_id. ~80% of every
-- "human" funnel row in the prior 14 days.
--
-- Rows before 2026-08-23 02:00Z are left alone: bot_ua there means UNKNOWN.
--
-- Revert:
--   UPDATE public.funnel_events f SET bot_ua = false
--     FROM public.audit_20260930_funnel_bot_ua_flipped a WHERE f.id = a.id;
--   DROP TABLE public.audit_20260930_funnel_bot_ua_flipped;

CREATE TABLE IF NOT EXISTS public.audit_20260930_funnel_bot_ua_flipped (
  id bigint PRIMARY KEY,
  user_agent text,
  flipped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260930_funnel_bot_ua_flipped ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260930_funnel_bot_ua_flipped FROM PUBLIC, anon, authenticated;

WITH hit AS (
  SELECT f.id, f.user_agent
  FROM public.funnel_events f
  CROSS JOIN LATERAL (
    SELECT regexp_match(f.user_agent,
      '\((?:iPhone|iPad|iPod)[^)]*?\mOS (\d+)_\d+[^)]*\).*?\mVersion/(\d+)') AS g
  ) m
  WHERE f.bot_ua = false
    AND f.created_at >= '2026-08-23 02:00+00'
    AND f.user_agent ~ 'Version/'
    AND m.g IS NOT NULL
    AND m.g[1]::int < 18
    AND m.g[2]::int >= 26
), logged AS (
  INSERT INTO public.audit_20260930_funnel_bot_ua_flipped (id, user_agent)
  SELECT id, user_agent FROM hit
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
UPDATE public.funnel_events f
   SET bot_ua = true
  FROM logged l
 WHERE f.id = l.id;
