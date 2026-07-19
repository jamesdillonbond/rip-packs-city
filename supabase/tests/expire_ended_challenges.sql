-- DB invariant: public.expire_ended_challenges — flips challenges whose window has
-- closed from 'active' to 'ended'. The safety property that matters (documented in
-- lib/challenges/topshot-ingest.ts): it is PURELY time-based, so a partial upstream
-- fetch can never wrongly expire a still-future challenge, and it only ever moves
-- active → ended (never resurrects or double-counts), scoped to one collection.
-- DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260716151708_audit_20260716_expire_ended_challenges.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-in for the challenges table (only the columns the guard reads/writes).
CREATE TABLE challenges (
  id bigserial PRIMARY KEY,
  collection_id uuid,
  status text,
  ends_at timestamptz
);

-- >>> BEGIN verbatim expire_ended_challenges (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.expire_ended_challenges(
  p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '30s'
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.challenges
     SET status = 'ended'          -- updated_at is owned by the challenges_touch_updated_at trigger
   WHERE collection_id = p_collection_id
     AND status = 'active'
     AND ends_at IS NOT NULL
     AND ends_at < now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
-- <<< END verbatim expire_ended_challenges <<<

-- Collection A is the function's default; B is a different collection.
-- id 1: active, window already closed        → MUST expire
-- id 2: active, window still open (future)    → MUST stay active
-- id 3: active, ends_at NULL (unknown window) → MUST stay active (partial-fetch safety)
-- id 4: already ended, window closed          → stays ended, NOT re-counted
-- id 5: active, closed, but a DIFFERENT collection → untouched by an A call
INSERT INTO challenges (collection_id, status, ends_at) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'active', now() - interval '2 days'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'active', now() + interval '5 days'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'active', NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ended',  now() - interval '9 days'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'active', now() - interval '2 days');

-- Exactly one row (id 1) is newly expired for collection A.
SELECT _assert_eq(
  (SELECT expire_ended_challenges('95f28a17-224a-4025-96ad-adf8a4c63bfd')::text),
  '1', 'exactly the one closed active challenge is expired');

SELECT _assert_eq((SELECT status FROM challenges WHERE id = 1), 'ended', 'closed active → ended');
SELECT _assert_eq((SELECT status FROM challenges WHERE id = 2), 'active', 'future challenge stays active');
SELECT _assert_eq((SELECT status FROM challenges WHERE id = 3), 'active', 'NULL ends_at stays active (partial-fetch safety)');
SELECT _assert_eq((SELECT status FROM challenges WHERE id = 4), 'ended', 'already-ended stays ended');
SELECT _assert_eq((SELECT status FROM challenges WHERE id = 5), 'active', 'other collection is untouched');

-- Idempotent: a second call for the same collection expires nothing more.
SELECT _assert_eq(
  (SELECT expire_ended_challenges('95f28a17-224a-4025-96ad-adf8a4c63bfd')::text),
  '0', 'second call is a no-op');

SELECT '✓ expire_ended_challenges invariants pass' AS result;
ROLLBACK;
