-- audit_20261102_pack_chase_watches — 2026-11-02 (Claude Code cloud; Trevor: "Do it all").
--
-- Per-user "chase" watches on a Top Shot pack distribution: tell me when this pack's
-- Legendary / Ultimate / Rare density per sealed pack reaches N× its launch rate.
-- Read and written ONLY by the session-authed /api/alerts/pack-chase route and the
-- alerts-dispatch cron (service role). RLS on, no policies: anon/authenticated reach
-- nothing directly. Deliveries ride the existing alert_deliveries outbox as
-- alert_kind 'pack_digest' (already allowed by its CHECK since 20260721121000).
--
-- armed: fire once when the condition becomes true, re-arm when it is next false —
-- the same edge-trigger shape as fmv_alerts.armed — so a pack that stays rich does not
-- re-alert every 15-minute tick.
--
-- REVERT: DROP TABLE public.pack_chase_watches;

CREATE TABLE public.pack_chase_watches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key       text NOT NULL,
  dist_id         text NOT NULL,
  title           text,
  tier            text NOT NULL CHECK (tier IN ('legendary', 'ultimate', 'rare')),
  min_vs_launch   numeric NOT NULL DEFAULT 2 CHECK (min_vs_launch >= 1 AND min_vs_launch <= 1000),
  active          boolean NOT NULL DEFAULT true,
  armed           boolean NOT NULL DEFAULT true,
  last_fired_at   timestamptz,
  last_fired_vs   numeric,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_key, dist_id, tier)
);

CREATE INDEX pack_chase_watches_active_idx ON public.pack_chase_watches (dist_id) WHERE active;

ALTER TABLE public.pack_chase_watches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_chase_watches FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pack_chase_watches TO service_role;
