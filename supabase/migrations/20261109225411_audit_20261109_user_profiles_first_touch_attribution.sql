-- audit_20261109_user_profiles_first_touch_attribution
--
-- Signup-wave remediation P2 (2026-11-09): the referrer/UTM attribution gap.
--
-- Measured 11-09: of 15 accounts created in the prior 7 days, 5 had ANY
-- funnel_events row tied to their user_id and 1 had a referrer. Campaign
-- attribution lives in sessionStorage (lib/track-funnel.ts), and a magic-link
-- signup opens a NEW tab, so the visit that brought the collector in is gone by
-- the time they are an account.
--
-- Additive only: four nullable columns, written ONCE per user (first write
-- wins, enforced in the writer's WHERE and again by the route), by
-- /api/profile/attribution with the service role. No backfill (there is
-- nothing to backfill from), no reader changes, no RLS change: user_profiles'
-- existing policies apply to the new columns as to the old.
--
-- Revert: ALTER TABLE public.user_profiles
--   DROP COLUMN first_touch_attribution, DROP COLUMN first_touch_landing,
--   DROP COLUMN first_touch_at, DROP COLUMN first_touch_visitor_id;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS first_touch_attribution text,
  ADD COLUMN IF NOT EXISTS first_touch_landing text,
  ADD COLUMN IF NOT EXISTS first_touch_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_touch_visitor_id text;

COMMENT ON COLUMN public.user_profiles.first_touch_attribution IS
  'First-touch campaign attribution for this browser before signup (utm_*, share_ref, ref=<external origin+path>), same format as funnel_events.referrer. Written once by /api/profile/attribution (2026-11-09). NULL = not captured (privacy signal, other device, or pre-2026-11-09 account), never "direct".';
COMMENT ON COLUMN public.user_profiles.first_touch_landing IS
  'Path (no query) of the first page this browser landed on before signup. Written once with first_touch_attribution.';
COMMENT ON COLUMN public.user_profiles.first_touch_at IS
  'When that first visit happened (client clock, clamped server-side to not-after-now). Written once.';
COMMENT ON COLUMN public.user_profiles.first_touch_visitor_id IS
  'The rpc_vid of that browser, so pre-signup funnel_events rows can be joined to the account. Written once.';
