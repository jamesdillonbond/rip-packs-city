-- audit_20260720_funnel_events_signup_funnel
--
-- Widen funnel_events.event_type to add the signup-funnel events. The 07-17
-- un-gate + 07-20 open-door means the missing measurement is now SIGNUP, not
-- browsing (home_view/wallet_paste/share_view/collection_view already cover
-- landing -> search -> result -> collection). Add exactly the 3 events that are
-- actually wired: a CTA click intent, a successful auth confirm, and the new
-- deal-watch email capture. Deliberately NOT adding onboarding_modal_* (the
-- OnboardingModal was removed 07-20) or search_* (already covered) so the
-- allowlist never lists an event type nothing emits.
--
-- Applied to prod via MCP as audit_20260720_funnel_events_signup_funnel; this
-- file is repo/rebuild parity.
--
-- REVERT: re-add the 7-value CHECK (drop 'signin_click','account_created',
-- 'email_capture_submitted').

ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_event_type_check;
ALTER TABLE public.funnel_events ADD CONSTRAINT funnel_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'home_view','wallet_paste','share_view','share_cta_click','insights_view',
    'insights_card_click','collection_view',
    -- signup funnel (2026-07-20):
    'signin_click','account_created','email_capture_submitted'
  ]::text[]));
