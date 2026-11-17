-- Baseline capture for the get_team_activity shape change.
-- Holds the OUTPUT OF THE CURRENT (pre-change) function for a spread of
-- (collection, team_slug, limit, offset) cases so the post-change output can be
-- compared byte-for-byte. Read-only audit scratch; no anon access.
--
-- REVERT: DROP TABLE IF EXISTS public.audit_20260901_team_activity_baseline;

CREATE TABLE IF NOT EXISTS public.audit_20260901_team_activity_baseline (
  coll_id     uuid        NOT NULL,
  coll_slug   text        NOT NULL,
  team_slug   text        NOT NULL,
  p_limit     int         NOT NULL,
  p_offset    int         NOT NULL,
  eds         int,
  captured_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb,
  PRIMARY KEY (coll_id, team_slug, p_limit, p_offset)
);

ALTER TABLE public.audit_20260901_team_activity_baseline ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260901_team_activity_baseline FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.audit_20260901_team_activity_baseline TO postgres, service_role;