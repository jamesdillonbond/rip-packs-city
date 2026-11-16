-- audit_20261116_alert_deliveries_allow_onboarding_kinds
--
-- alert_deliveries.alert_kind is CHECK-whitelisted. Two email senders claim rows
-- under kinds the CHECK did not allow, so every claim failed (fail-closed: the
-- recipient is skipped and a guard error logged, nothing sent):
--   * 'day1_onboarding' — app/api/cron/day1-onboarding (new 2026-11-16);
--   * 'signup_reminder' — app/api/cron/signup-reminder (latent since 2026-07-24;
--     the route is behind SIGNUP_REMINDER_ENABLED, which was never set, so the
--     failure never surfaced).
-- 978 rows, 2 kinds in use today; the widened CHECK validates in one pass.
-- Revert: re-add the four-value CHECK (only after deleting any rows of the two new kinds).

ALTER TABLE public.alert_deliveries DROP CONSTRAINT alert_deliveries_alert_kind_check;
ALTER TABLE public.alert_deliveries ADD CONSTRAINT alert_deliveries_alert_kind_check
  CHECK (alert_kind = ANY (ARRAY['deal'::text, 'fmv'::text, 'pack_digest'::text, 'weekly_digest'::text, 'day1_onboarding'::text, 'signup_reminder'::text]));
