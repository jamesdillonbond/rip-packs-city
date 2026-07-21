-- audit_20260721_alert_deliveries_allow_weekly_digest
--
-- Widen the alert_deliveries.alert_kind CHECK to allow 'weekly_digest', the kind
-- used by the retention weekly-digest route for idempotency (via the existing
-- UNIQUE (owner_key, channel, alert_kind, subject_key, dedup_bucket)).
--
-- Additive + inert: no existing rows use 'weekly_digest'; nothing writes it until
-- /api/cron/weekly-digest is enabled (WEEKLY_DIGEST_ENABLED=1). The weekly-digest
-- route writes rows with status='sent' (never 'pending'), so the generic
-- alerts-send sender (which only claims status='pending') never touches them.
--
-- Applied live via MCP on 2026-07-21.
--
-- Revert (only after deleting any weekly_digest rows):
--   DELETE FROM public.alert_deliveries WHERE alert_kind = 'weekly_digest';
--   ALTER TABLE public.alert_deliveries DROP CONSTRAINT alert_deliveries_alert_kind_check;
--   ALTER TABLE public.alert_deliveries ADD CONSTRAINT alert_deliveries_alert_kind_check
--     CHECK (alert_kind = ANY (ARRAY['deal'::text, 'fmv'::text, 'pack_digest'::text]));

ALTER TABLE public.alert_deliveries DROP CONSTRAINT alert_deliveries_alert_kind_check;
ALTER TABLE public.alert_deliveries ADD CONSTRAINT alert_deliveries_alert_kind_check
  CHECK (alert_kind = ANY (ARRAY['deal'::text, 'fmv'::text, 'pack_digest'::text, 'weekly_digest'::text]));
