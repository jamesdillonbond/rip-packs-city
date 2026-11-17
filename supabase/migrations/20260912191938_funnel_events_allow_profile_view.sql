-- 2026-09-12 · funnel_events: admit `profile_view`.
--
-- WHY. /profile/<username> is the landing page for every share link the product
-- emits (ShareProfileButtons builds it with utm_source=share&utm_medium=x plus
-- the sharer's &ref=), and it was the one page type in the product that fired
-- NOTHING into funnel_events. Measured whole-table on 2026-09-12, 28,129 rows:
--
--   surface ILIKE '%profile%'           0
--   surface ILIKE '%trophy%'            0
--   referrer ILIKE '%utm_source=share%' 0
--
-- So a visitor who clicked a shared profile link was invisible, and the
-- utm_source=share we carefully attach was dropped on the floor. Vercel Web
-- Analytics is NOT enabled on this project (get_web_analytics -> 404), so
-- funnel_events is the only instrument there is.
--
-- ONE new event_type, not two. The trophy case is distinguished by `surface`
-- (the pathname), exactly as `collection_view` carries its tab that way — see
-- the note on collection_view in app/api/track-funnel/route.ts. Adding a
-- sub-page under /profile therefore needs no further CHECK change.
--
-- ⚠ THIS CONSTRAINT IS ONE OF THREE ALLOWLISTS and they must move together:
--   1. this CHECK                             (rejects the INSERT)
--   2. ALLOWED_EVENT_TYPES in app/api/track-funnel/route.ts  (rejects at the route)
--   3. the FunnelEventType union in lib/track-funnel.ts      (rejects at compile)
-- The route returns HTTP 200 {ok:false} on an unknown type, so shipping the
-- client without this migration would have produced a beacon that looks
-- accepted and stores nothing — an accepted event is not a stored event.
--
-- REVERT: re-run this statement with 'profile_view' removed from the array.
-- Any rows already written with that type must be deleted first, or the
-- re-added constraint will fail validation.

ALTER TABLE public.funnel_events
  DROP CONSTRAINT IF EXISTS funnel_events_event_type_check;

ALTER TABLE public.funnel_events
  ADD CONSTRAINT funnel_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'home_view'::text,
    'wallet_paste'::text,
    'share_view'::text,
    'share_cta_click'::text,
    'insights_view'::text,
    'insights_card_click'::text,
    'collection_view'::text,
    'signin_click'::text,
    'account_created'::text,
    'email_capture_submitted'::text,
    -- 2026-09-12: public profile + its trophy-case sub-page.
    'profile_view'::text
  ]));
