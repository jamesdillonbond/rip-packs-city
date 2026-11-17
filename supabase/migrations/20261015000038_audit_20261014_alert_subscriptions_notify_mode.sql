-- audit_20261014 part 1 of 2 — the repeat-policy column. Part 2 (the
-- dispatch_due_deal_alerts body that reads it) is
-- 20261014235409_audit_20261014_deal_alerts_fire_once_per_listing.sql; the full
-- rationale is in that file. Split because the MCP write gate holds any
-- statement containing DROP, and that body carries its temp-table DROP.
-- REVERT: ALTER TABLE public.alert_subscriptions DROP COLUMN notify_mode;
ALTER TABLE public.alert_subscriptions
  ADD COLUMN IF NOT EXISTS notify_mode text NOT NULL DEFAULT 'new_listing'
  CONSTRAINT alert_subscriptions_notify_mode_check
  CHECK (notify_mode IN ('new_listing', 'once', 'daily'));

COMMENT ON COLUMN public.alert_subscriptions.notify_mode IS
  'Repeat policy read by dispatch_due_deal_alerts (audit_20261014): new_listing = once per listing (a different moment or ask re-fires); once = first delivery per subject per channel only; daily = re-send each UTC day while it matches. alert_subscriptions.cadence is NOT read by anything.';
