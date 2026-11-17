-- audit_20260903_sentinel_threshold_config_ack_with_reason_and_expiry
--
-- WHY. `/api/sentinel`'s Detector Health arm (known-issues #25) pages CRITICAL on a
-- consecutive-failure streak of a watched GitHub Actions detector. It took its
-- first real reading on 2026-08-30 (GITHUB_ACTIONS_READ_TOKEN set) and found
-- `edge-fn-drift` at a 12x streak. That red is CORRECT — the detector reports 6
-- deployed edge functions that do not match `main` — and it CANNOT be cleared by
-- engineering work: 4 of the 6 (compute-golazos-pack-ev, ingest-allday-pack-opens,
-- ingest-pinnacle-mints, ingest-topshot-pack-opens-history) wait on an operator
-- setting *_GATE_KEY secrets (deploying without them 403s every tick — the
-- 2026-08-11 outage mechanism), and 2 (enrich-ufc-wallet, sync-nba-projections)
-- are deferred by recorded decision in scripts/check-edge-fn-drift.mjs
-- DEPLOY_DEFERRED (transport limits of the MCP deploy path). So the fleet's
-- top-level alarm has read CRITICAL on every hourly run since 2026-08-30 for a
-- condition outside the estate, and every OTHER arm's critical now lands in an
-- already-red report. Filed 2026-08-31 (inbox
-- 2026-08-31T0700Z-the-fleet-alarm-went-permanently-critical-...), which
-- recommended exactly this shape and said the DECISION to use it is Trevor's.
-- Trevor decided 2026-09-03: build it and ack Detector Health for 30 days.
--
-- WHAT. Two nullable columns on the existing per-check config table: an ack
-- carries WHO/WHY (`ack_reason`) and WHEN IT RE-SURFACES (`ack_expires_at`). The
-- route downgrades a CRITICAL check with an unexpired ack to WARN (never ok) and
-- renders the reason and date in the check's detail; an expired ack leaves the
-- check critical and is rendered as expired. The pair CHECK stops half an ack
-- (a reason with no expiry is `enabled=false` with extra steps — permanent and
-- silent, which the 08-31 filing explicitly warned against).
--
-- The one row inserted here is the ack Trevor approved. `warn_at`/`crit_at` stay
-- NULL so the arm keeps its hardcoded 3/7 — this row acks, it does not retune.
--
-- SECURITY. Table unchanged in posture: RLS on, grants postgres + service_role
-- only (verified 2026-09-03 via information_schema.role_table_grants — no anon,
-- no authenticated). anon-exec: n/a — no function is created or replaced.
--
-- REVERT (data half): DELETE FROM public.sentinel_threshold_config
--   WHERE check_name = 'Detector Health (GitHub Actions)';
-- REVERT (DDL half): ALTER TABLE public.sentinel_threshold_config
--   DROP CONSTRAINT sentinel_threshold_config_ack_pair_chk,
--   DROP COLUMN ack_reason, DROP COLUMN ack_expires_at;
-- The route tolerates both: a missing column fails the config read, and every
-- check then uses its hardcoded threshold (the documented pre-existing fallback).

ALTER TABLE public.sentinel_threshold_config
  ADD COLUMN IF NOT EXISTS ack_reason text,
  ADD COLUMN IF NOT EXISTS ack_expires_at timestamptz;

ALTER TABLE public.sentinel_threshold_config
  DROP CONSTRAINT IF EXISTS sentinel_threshold_config_ack_pair_chk;
ALTER TABLE public.sentinel_threshold_config
  ADD CONSTRAINT sentinel_threshold_config_ack_pair_chk
  CHECK ((ack_reason IS NULL) = (ack_expires_at IS NULL));

COMMENT ON COLUMN public.sentinel_threshold_config.ack_reason IS
  'Acknowledgement of a CRITICAL reading: who owns it and why it cannot clear yet. Honoured by /api/sentinel only together with ack_expires_at; downgrades critical to warn (never ok) while unexpired.';
COMMENT ON COLUMN public.sentinel_threshold_config.ack_expires_at IS
  'When the acknowledgement lapses. After this instant the check pages critical again and its detail says the ack expired. Never NULL while ack_reason is set (pair CHECK).';

INSERT INTO public.sentinel_threshold_config (check_name, warn_at, crit_at, enabled, ack_reason, ack_expires_at, note)
VALUES (
  'Detector Health (GitHub Actions)',
  NULL,
  NULL,
  true,
  'edge-fn-drift is CORRECTLY red and cannot be cleared by engineering work: 6 drifted functions, of which 4 (compute-golazos-pack-ev, ingest-allday-pack-opens, ingest-pinnacle-mints, ingest-topshot-pack-opens-history) wait on an operator setting *_GATE_KEY secrets and 2 (enrich-ufc-wallet, sync-nba-projections) are deferred by recorded decision (scripts/check-edge-fn-drift.mjs DEPLOY_DEFERRED). Owner: Trevor. Acked 2026-09-03 on his decision; known-issues #25, inbox 2026-08-31T0700Z.',
  '2026-10-03T07:00:00Z',
  'Ack row only — warn_at/crit_at NULL so the route keeps its hardcoded 3/7. Re-surfaces 2026-10-03 00:00 PT.'
)
ON CONFLICT (check_name) DO UPDATE SET
  ack_reason = EXCLUDED.ack_reason,
  ack_expires_at = EXCLUDED.ack_expires_at,
  note = EXCLUDED.note,
  updated_at = now();
