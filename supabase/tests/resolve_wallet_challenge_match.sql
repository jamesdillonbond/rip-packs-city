-- DB invariant: public.resolve_wallet_challenge_match(uuid,text,text,uuid) — the
-- credit-granting side of the on-demand listing-challenge wallet verification.
-- Load-bearing properties (all abuse-relevant, since points are a reward
-- currency): (a) guard ordering not_found → already_resolved → expired, (b) the
-- saved_wallet is marked verified, (c) `link_wallet` points are always awarded on
-- success, and (d) the `referral_verified` bonus is granted ONLY on a genuinely
-- first verification, never on a self-referral, and only for a referrer that is a
-- real profile.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801160400_audit_20260801_snapshot_resolve_wallet_challenge_match.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- award_points() is an external dependency, STUBBED here to a deterministic marker
-- so the test asserts WHICH awards fire without pulling the whole points engine.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE wallet_verification_challenges (
  id                uuid PRIMARY KEY,
  user_id           uuid,
  wallet_addr       text,
  resolved_at       timestamptz,
  resolved_via      text,
  matched_moment_id text,
  expires_at        timestamptz
);
CREATE TABLE saved_wallets (
  user_id             uuid,
  wallet_addr         text,
  verified_at         timestamptz,
  verification_method text
);
CREATE TABLE user_profiles (id uuid PRIMARY KEY);

-- Stub award_points → returns a marker naming the event + subject.
CREATE OR REPLACE FUNCTION public.award_points(p_user uuid, p_event text, p_subject text)
RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('awarded', p_event, 'subject', p_subject) $$;

-- >>> BEGIN verbatim resolve_wallet_challenge_match (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.resolve_wallet_challenge_match(p_challenge_id uuid, p_matched_moment_id text, p_source text DEFAULT 'gql_on_demand'::text, p_referrer uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE c record; v_award jsonb; v_ref_award jsonb; v_first boolean;
BEGIN
  SELECT * INTO c FROM wallet_verification_challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','challenge_not_found'); END IF;
  IF c.resolved_at IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error','already_resolved','via',c.resolved_via); END IF;
  IF c.expires_at < now() THEN
    UPDATE wallet_verification_challenges SET resolved_at = now(), resolved_via = 'expired' WHERE id = p_challenge_id;
    RETURN jsonb_build_object('ok',false,'error','expired');
  END IF;

  -- Is this the user's first-ever verified wallet? (checked BEFORE verifying)
  v_first := NOT EXISTS (SELECT 1 FROM saved_wallets WHERE user_id = c.user_id AND verified_at IS NOT NULL);

  UPDATE wallet_verification_challenges
     SET resolved_at = now(), resolved_via = coalesce(p_source,'gql_on_demand'),
         matched_moment_id = p_matched_moment_id
   WHERE id = p_challenge_id;

  UPDATE saved_wallets
     SET verified_at = now(), verification_method = 'listing_challenge'
   WHERE user_id = c.user_id AND lower(wallet_addr) = lower(c.wallet_addr)
     AND verified_at IS NULL;

  v_award := award_points(c.user_id, 'link_wallet', c.wallet_addr);

  -- Referral: only on a genuinely-first verification, never self, referrer must be real.
  IF p_referrer IS NOT NULL AND v_first AND p_referrer <> c.user_id
     AND EXISTS (SELECT 1 FROM user_profiles up WHERE up.id = p_referrer) THEN
    v_ref_award := award_points(p_referrer, 'referral_verified', c.user_id::text);
  END IF;

  RETURN jsonb_build_object('ok',true,'challenge_id',c.id,'user_id',c.user_id,
                            'wallet',lower(c.wallet_addr),'moment',p_matched_moment_id,
                            'first_verification',v_first,
                            'link_wallet_award',v_award,'referral_award',v_ref_award);
END $function$;
-- <<< END verbatim resolve_wallet_challenge_match <<<

-- Fixed uuids
-- user U  = 00000000-0000-0000-0000-000000000011
-- referrer R = 00000000-0000-0000-0000-000000000021
INSERT INTO user_profiles VALUES ('00000000-0000-0000-0000-000000000011'),
                                 ('00000000-0000-0000-0000-000000000021');

-- Guard 1: a non-existent challenge id → challenge_not_found.
SELECT _assert_eq(
  (resolve_wallet_challenge_match('dddddddd-0000-0000-0000-000000000000','m')->>'error'),
  'challenge_not_found', 'unknown challenge → not_found');

-- Guard 2: an already-resolved challenge → already_resolved (+ via).
INSERT INTO wallet_verification_challenges VALUES
  ('c0000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','0xWALLET', now(), 'gql_on_demand', NULL, now() + interval '1 hour');
SELECT _assert_eq(
  (resolve_wallet_challenge_match('c0000000-0000-0000-0000-000000000001','m')->>'error'),
  'already_resolved', 'resolved challenge → already_resolved');

-- Guard 3: an expired, unresolved challenge → expired, and it is stamped expired.
INSERT INTO wallet_verification_challenges VALUES
  ('c0000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000011','0xWALLET', NULL, NULL, NULL, now() - interval '1 minute');
SELECT _assert_eq(
  (resolve_wallet_challenge_match('c0000000-0000-0000-0000-000000000002','m')->>'error'),
  'expired', 'past-expiry challenge → expired');
SELECT _assert_eq(
  (SELECT resolved_via FROM wallet_verification_challenges WHERE id='c0000000-0000-0000-0000-000000000002'),
  'expired', 'expired challenge stamped resolved_via=expired');

-- Happy path, FIRST verification, WITH a valid referrer → both awards fire,
-- saved_wallet verified, first_verification=true.
INSERT INTO wallet_verification_challenges VALUES
  ('c0000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000011','0xAbCdEf', NULL, NULL, NULL, now() + interval '1 hour');
INSERT INTO saved_wallets VALUES ('00000000-0000-0000-0000-000000000011','0xabcdef', NULL, NULL);
SELECT _assert(
  (resolve_wallet_challenge_match('c0000000-0000-0000-0000-000000000003','moment9','gql_on_demand','00000000-0000-0000-0000-000000000021')->'referral_award'->>'awarded') = 'referral_verified',
  'first verification + valid referrer → referral bonus fires');
SELECT _assert_eq(
  (SELECT verification_method FROM saved_wallets WHERE user_id='00000000-0000-0000-0000-000000000011'),
  'listing_challenge', 'saved_wallet marked verified (case-insensitive addr match)');

-- NOT-first verification (the user now already has a verified wallet from
-- challenge3) → NO referral bonus even with a valid referrer. Single call;
-- `->>` maps a JSON-null referral_award to SQL NULL (the `->` operator would
-- return jsonb 'null', which is NOT SQL NULL).
INSERT INTO wallet_verification_challenges VALUES
  ('c0000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000011','0xSECOND', NULL, NULL, NULL, now() + interval '1 hour');
SELECT _assert(
  (SELECT (r->>'first_verification') = 'false' AND (r->>'referral_award') IS NULL
   FROM (SELECT resolve_wallet_challenge_match('c0000000-0000-0000-0000-000000000004','m','gql_on_demand','00000000-0000-0000-0000-000000000021') AS r) t),
  'second verification → first_verification=false and no referral bonus');

-- SELF-referral (referrer = the verifying user) on a first verification → NO bonus.
INSERT INTO wallet_verification_challenges VALUES
  ('c0000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000021','0xREFSELF', NULL, NULL, NULL, now() + interval '1 hour');
SELECT _assert(
  (SELECT (r->>'first_verification') = 'true' AND (r->>'referral_award') IS NULL
   FROM (SELECT resolve_wallet_challenge_match('c0000000-0000-0000-0000-000000000005','m','gql_on_demand','00000000-0000-0000-0000-000000000021') AS r) t),
  'self-referral on a first verification → no referral bonus');

-- UNKNOWN referrer (not in user_profiles) on a fresh first verification → NO bonus,
-- but link_wallet award still fires.
INSERT INTO wallet_verification_challenges VALUES
  ('c0000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000031','0xFRESH', NULL, NULL, NULL, now() + interval '1 hour');
SELECT _assert(
  (SELECT (r->>'referral_award') IS NULL AND (r->'link_wallet_award'->>'awarded') = 'link_wallet'
   FROM (SELECT resolve_wallet_challenge_match('c0000000-0000-0000-0000-000000000006','m','gql_on_demand','99999999-9999-9999-9999-999999999999') AS r) t),
  'unknown referrer → no referral bonus, but link_wallet award still fires');

SELECT '✓ resolve_wallet_challenge_match invariants pass' AS result;
ROLLBACK;
