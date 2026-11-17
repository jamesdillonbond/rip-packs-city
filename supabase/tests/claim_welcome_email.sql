-- DB invariant: public.claim_welcome_email + public.record_welcome_email_failure — the once-per-account
-- claim behind the transactional welcome email (migration
-- 20261012054000_audit_20261011_user_profiles_welcome_email_claim_is_idempotent.sql). Claims:
--   1. a 'pending' account is claimed exactly ONCE: the first call returns true and stamps
--      welcome_sent_at; the second returns false and changes nothing;
--   2. an unknown id (no profile row) is false — no account, no email;
--   3. a 'pre_existing' account (the backfill) can NEVER be claimed, however many times it is asked;
--   4. a recorded send failure reverts the claim (sent → pending, sent_at NULL, error kept) so the next
--      claim succeeds again — but attempts are NOT reverted, so the 3rd failure ends the retries;
--   5. a failure recorded against a row that is NOT 'sent' (or whose claim is older than 10 minutes)
--      changes nothing — a stale call cannot un-send a real welcome.
--
-- The function DDL below is VERBATIM from the committed migration;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  welcome_state text NOT NULL DEFAULT 'pending'
    CONSTRAINT user_profiles_welcome_state_check CHECK (welcome_state IN ('pending', 'sent', 'pre_existing')),
  welcome_sent_at timestamptz,
  welcome_error text,
  welcome_attempts integer NOT NULL DEFAULT 0
);

-- >>> BEGIN verbatim claim_welcome_email >>>
CREATE OR REPLACE FUNCTION public.claim_welcome_email(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_claimed boolean := false;
BEGIN
  -- One UPDATE, one row lock: of N concurrent callers for the same account exactly one sees
  -- welcome_state = 'pending' after acquiring the lock and flips it; the rest return false.
  -- A row that does not exist (no profile → no account) updates nothing → false.
  UPDATE public.user_profiles
     SET welcome_state    = 'sent',
         welcome_sent_at  = now(),
         welcome_attempts = welcome_attempts + 1,
         welcome_error    = NULL
   WHERE id = p_user_id
     AND welcome_state = 'pending'
     AND welcome_attempts < 3
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END
$function$;
-- <<< END verbatim claim_welcome_email <<<

-- >>> BEGIN verbatim record_welcome_email_failure >>>
CREATE OR REPLACE FUNCTION public.record_welcome_email_failure(p_user_id uuid, p_error text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Revert a claim whose send failed so a later sign-in can retry. Bounded two ways: only a
  -- row still marked 'sent' by a claim in the last 10 minutes (a stale call cannot un-send a
  -- real welcome), and welcome_attempts is left incremented so claim_welcome_email refuses at 3.
  UPDATE public.user_profiles
     SET welcome_state   = 'pending',
         welcome_sent_at = NULL,
         welcome_error   = left(COALESCE(p_error, 'unknown error'), 500)
   WHERE id = p_user_id
     AND welcome_state = 'sent'
     AND welcome_sent_at IS NOT NULL
     AND welcome_sent_at >= now() - interval '10 minutes';
END
$function$;
-- <<< END verbatim record_welcome_email_failure <<<

INSERT INTO public.user_profiles (id, welcome_state) VALUES
  ('11111111-1111-1111-1111-111111111111', 'pending'),
  ('22222222-2222-2222-2222-222222222222', 'pre_existing'),
  ('33333333-3333-3333-3333-333333333333', 'pending');

DO $$
DECLARE
  v boolean;
  n int;
BEGIN
  -- claim 1: exactly once
  v := public.claim_welcome_email('11111111-1111-1111-1111-111111111111');
  PERFORM _assert(v, 'first claim on a pending account returns true (claim 1)');
  PERFORM _assert_eq((SELECT welcome_state || ':' || welcome_attempts || ':' || (welcome_sent_at IS NOT NULL)
                        FROM public.user_profiles WHERE id = '11111111-1111-1111-1111-111111111111'),
                     'sent:1:true', 'the claim stamps sent + sent_at and counts one attempt (claim 1)');
  v := public.claim_welcome_email('11111111-1111-1111-1111-111111111111');
  PERFORM _assert(NOT v, 'second claim on the same account returns false (claim 1)');
  PERFORM _assert_eq((SELECT welcome_attempts::text FROM public.user_profiles WHERE id = '11111111-1111-1111-1111-111111111111'),
                     '1', 'a refused claim does not count an attempt (claim 1)');

  -- claim 2: unknown id
  v := public.claim_welcome_email('99999999-9999-9999-9999-999999999999');
  PERFORM _assert(NOT v, 'an id with no profile row is never claimed (claim 2)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.user_profiles), '3', 'and no row is created for it (claim 2)');

  -- claim 3: pre_existing is unclaimable
  v := public.claim_welcome_email('22222222-2222-2222-2222-222222222222');
  PERFORM _assert(NOT v, 'a pre_existing account is never claimed (claim 3)');
  PERFORM _assert_eq((SELECT welcome_state || ':' || welcome_attempts FROM public.user_profiles WHERE id = '22222222-2222-2222-2222-222222222222'),
                     'pre_existing:0', 'and the row is untouched (claim 3)');

  -- claim 4: a failed send reverts the claim; attempts accumulate; third failure ends retries
  v := public.claim_welcome_email('33333333-3333-3333-3333-333333333333');
  PERFORM _assert(v, 'attempt 1 claims (claim 4)');
  PERFORM public.record_welcome_email_failure('33333333-3333-3333-3333-333333333333', 'Resend HTTP 500');
  PERFORM _assert_eq((SELECT welcome_state || ':' || welcome_attempts || ':' || (welcome_sent_at IS NULL) || ':' || welcome_error
                        FROM public.user_profiles WHERE id = '33333333-3333-3333-3333-333333333333'),
                     'pending:1:true:Resend HTTP 500', 'a failure reverts to pending, clears sent_at, keeps the error and the attempt (claim 4)');
  v := public.claim_welcome_email('33333333-3333-3333-3333-333333333333');
  PERFORM _assert(v, 'attempt 2 claims again after a recorded failure (claim 4)');
  PERFORM _assert_eq((SELECT welcome_error FROM public.user_profiles WHERE id = '33333333-3333-3333-3333-333333333333'),
                     NULL, 'a new claim clears the previous error (claim 4)');
  PERFORM public.record_welcome_email_failure('33333333-3333-3333-3333-333333333333', 'Resend HTTP 502');
  v := public.claim_welcome_email('33333333-3333-3333-3333-333333333333');
  PERFORM _assert(v, 'attempt 3 claims (claim 4)');
  PERFORM public.record_welcome_email_failure('33333333-3333-3333-3333-333333333333', 'Resend HTTP 503');
  v := public.claim_welcome_email('33333333-3333-3333-3333-333333333333');
  PERFORM _assert(NOT v, 'a 4th claim is refused: three failures end the retries (claim 4)');
  PERFORM _assert_eq((SELECT welcome_state || ':' || welcome_attempts || ':' || welcome_error
                        FROM public.user_profiles WHERE id = '33333333-3333-3333-3333-333333333333'),
                     'pending:3:Resend HTTP 503', 'the row records three attempts and the last error (claim 4)');

  -- claim 5: a failure against a non-sent row, or a stale claim, changes nothing
  PERFORM public.record_welcome_email_failure('22222222-2222-2222-2222-222222222222', 'late');
  PERFORM _assert_eq((SELECT welcome_state || ':' || COALESCE(welcome_error, '<null>') FROM public.user_profiles WHERE id = '22222222-2222-2222-2222-222222222222'),
                     'pre_existing:<null>', 'a failure recorded against a pre_existing row is a no-op (claim 5)');
  UPDATE public.user_profiles SET welcome_sent_at = now() - interval '11 minutes'
   WHERE id = '11111111-1111-1111-1111-111111111111';
  PERFORM public.record_welcome_email_failure('11111111-1111-1111-1111-111111111111', 'late');
  PERFORM _assert_eq((SELECT welcome_state FROM public.user_profiles WHERE id = '11111111-1111-1111-1111-111111111111'),
                     'sent', 'a failure recorded more than 10 minutes after the claim cannot un-send it (claim 5)');
  SELECT count(*) INTO n FROM public.user_profiles WHERE welcome_state NOT IN ('pending', 'sent', 'pre_existing');
  PERFORM _assert_eq(n::text, '0', 'no row ever leaves the three states');
END $$;

SELECT '✓ claim_welcome_email invariants pass' AS result;
ROLLBACK;
