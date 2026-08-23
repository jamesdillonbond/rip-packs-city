-- audit_20260822_funnel_events_bot_flag
--
-- ⚠ READY TO APPLY — NOT YET APPLIED. Apply it in the healthy window
-- (20:00–00:00Z), not in the 01:00–19:00Z degraded band, because
-- `apply_migration` costs a ~10–20 s burst of user-facing PGRST002 500s from
-- schema-cache re-introspection. Written at 01:07Z, i.e. one hour into the
-- degraded band, which is the only reason it was not applied on the spot.
--
-- ✅ THE ROUTE IS ALREADY SAFE TO DEPLOY WITHOUT THIS. `app/api/track-funnel/
-- route.ts` inserts the full row, and on an unknown-column error retries the
-- old shape. Before this migration the new fields are a silent no-op; the moment
-- it lands they start recording with no second deploy. The ordering constraint
-- was REMOVED rather than documented and hoped for — shipping the route first
-- without that fallback would fail every insert and lose the whole funnel feed.
--
-- ── WHY (deep-audit R23) ────────────────────────────────────────────────────
-- MEASURED 7 days to 2026-08-22: 15,803 events across 15,689 distinct sessions.
-- Only 53 sessions (0.34%) fired more than one event. 99.82% carried a null
-- referrer. `getSessionId()` persists `rpc_sess` in sessionStorage, so a real
-- multi-page visit SHARES one id — 1.007 events/session is a crawler with fresh
-- storage per fetch, not a person browsing.
--
-- `collection_view` rose 82 → 7,738/day between 08-16 and 08-18 with ZERO change
-- in `wallet_paste`, signups or sign-ins. The table had no way to express that,
-- so any future reading of "views" as traction is wrong by roughly three orders
-- of magnitude. This is the `is_smoke_test` lesson in a new table — except there
-- the flag existed and was ignored, and here it did not exist at all.
--
-- ⚠ `bot_ua` IS A HEURISTIC AND IS NAMED FOR WHAT IT MEASURES. It records what
-- the User-Agent CLAIMS: a crawler that lies is not caught, and a real browser is
-- never flagged. It is the cheap first cut that makes an honest slice possible;
-- the stronger signals (one-event sessions, null referrer) stay in the analysis.
-- ⚠ Do NOT rename it to `is_bot` — that would assert more than it knows.
--
-- ⚠ EXISTING ROWS ARE NOT BACKFILLED and must not be read as human. `bot_ua`
-- defaults to false, and every row written before this lands has a false that
-- means UNKNOWN, not HUMAN. Any query over the pre-migration period must filter
-- on `created_at >= <apply time>` or state that it cannot separate the two.
--
-- Revert: ALTER TABLE public.funnel_events DROP COLUMN bot_ua, DROP COLUMN user_agent;

ALTER TABLE public.funnel_events
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS bot_ua boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.funnel_events.user_agent IS
  'Raw User-Agent, clamped to 512 chars, captured server-side. Null for rows written before 2026-08-23.';

COMMENT ON COLUMN public.funnel_events.bot_ua IS
  'HEURISTIC: the User-Agent self-identifies as automated. Not a certainty — a lying crawler is not caught. false on pre-2026-08-23 rows means UNKNOWN, not human. Slice by this BEFORE slicing by time.';

-- Partial index: the honest analytical cut is "real traffic only", so index the
-- rows that query actually reads rather than the whole table.
CREATE INDEX IF NOT EXISTS funnel_events_human_created_idx
  ON public.funnel_events (created_at DESC)
  WHERE bot_ua = false;
