-- Phase 1 parent-signed gifting: record of gift transactions (analytics/audit).
-- Writes go through the service-role /api/gift/record route; RLS-on, no public policies.
CREATE TABLE IF NOT EXISTS public.moment_gifts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL,
  parent_addr         text NOT NULL,
  child_addr          text NOT NULL,
  moment_id           text NOT NULL,
  edition_external_id text,
  moment_title        text,
  serial_number       integer,
  recipient_addr      text NOT NULL,
  recipient_label     text,
  tx_id               text,
  status              text NOT NULL DEFAULT 'submitted'
                       CHECK (status = ANY (ARRAY['submitted','sealed','failed'])),
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sealed_at           timestamptz,
  CONSTRAINT moment_gifts_parent_addr_fmt   CHECK (parent_addr    ~ '^0x[0-9a-f]{16}$'),
  CONSTRAINT moment_gifts_child_addr_fmt    CHECK (child_addr     ~ '^0x[0-9a-f]{16}$'),
  CONSTRAINT moment_gifts_recipient_addr_fmt CHECK (recipient_addr ~ '^0x[0-9a-f]{16}$')
);

ALTER TABLE public.moment_gifts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.moment_gifts FROM anon, authenticated;
GRANT ALL ON public.moment_gifts TO service_role;

CREATE INDEX IF NOT EXISTS idx_moment_gifts_user      ON public.moment_gifts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moment_gifts_recipient ON public.moment_gifts (recipient_addr);

-- Unique on tx_id so /api/gift/record can upsert (submitted -> sealed/failed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_moment_gifts_tx
  ON public.moment_gifts (tx_id) WHERE tx_id IS NOT NULL;

COMMENT ON TABLE public.moment_gifts IS
  'Parent-signed Hybrid-Custody gift transactions (Phase 1). Service-role writes via /api/gift/record; RLS-on, no anon/authenticated access.';
