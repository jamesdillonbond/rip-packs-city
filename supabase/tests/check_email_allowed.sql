-- DB invariant: public.check_email_allowed — the LOGIN FRONT DOOR gate. proxy.ts
-- and /api/auth/request-magic-link call it to decide whether an email may receive
-- a magic link / pass the authed-route gate. Since 2026-07-20 it is OPEN BY
-- DEFAULT: any email passes EXCEPT one that is explicitly blocked. A regression
-- here has two opposite catastrophic modes — flip a branch and you either lock
-- every user out (false) or let a banned user back in (true). Neither is visible
-- from the app until a real person hits it, so this invariant is pinned.
--
-- The blocks are: (a) an allow_list row for the email with revoked_at set OR a
-- blocking status (revoked/rejected/banned/suspended/denied/blocked), or (b) an
-- ACTIVE, unexpired deny_list entry matching the exact email ('email') or the
-- whole domain ('email_domain', tolerant of a leading '@' in the pattern).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260720210000_audit_20260720_open_front_door_check_email_allowed.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal fixtures: only the columns the function references.
CREATE TABLE public.allow_list (
  email text NOT NULL,
  status text,
  revoked_at timestamptz
);

CREATE TABLE public.deny_list (
  pattern text NOT NULL,
  pattern_type text NOT NULL,     -- 'email' | 'email_domain'
  active boolean,
  expires_at timestamptz
);

-- >>> BEGIN verbatim check_email_allowed (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.check_email_allowed(p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    NOT EXISTS (
      SELECT 1 FROM public.allow_list a
      WHERE lower(a.email) = lower(trim(p_email))
        AND (
          a.revoked_at IS NOT NULL
          OR a.status IN ('revoked','rejected','banned','suspended','denied','blocked')
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.deny_list d
      WHERE d.active IS TRUE
        AND (d.expires_at IS NULL OR d.expires_at > now())
        AND (
          (d.pattern_type = 'email'
             AND lower(d.pattern) = lower(trim(p_email)))
          OR (d.pattern_type = 'email_domain'
             AND lower(split_part(trim(p_email), '@', 2)) = lower(trim(both '@' from d.pattern)))
        )
    );
$function$;
-- <<< END verbatim check_email_allowed <<<

-- (1) OPEN BY DEFAULT: an email with no allow_list/deny_list rows is allowed.
SELECT _assert_eq(public.check_email_allowed('newuser@example.com')::text,
  'true', 'unknown email is allowed (front door open)');

-- (2) An active/normal allow_list row does NOT block (allow-by-default, not invite-only).
INSERT INTO public.allow_list (email, status) VALUES ('member@example.com', 'active');
SELECT _assert_eq(public.check_email_allowed('member@example.com')::text,
  'true', 'active allow_list member is allowed');

-- (3) revoked_at set → blocked, even with an otherwise-fine status.
INSERT INTO public.allow_list (email, status, revoked_at)
  VALUES ('revoked@example.com', 'active', now());
SELECT _assert_eq(public.check_email_allowed('revoked@example.com')::text,
  'false', 'allow_list row with revoked_at is blocked');

-- (4) Each blocking status blocks.
INSERT INTO public.allow_list (email, status) VALUES
  ('banned@example.com', 'banned'),
  ('suspended@example.com', 'suspended'),
  ('blocked@example.com', 'blocked');
SELECT _assert_eq(public.check_email_allowed('banned@example.com')::text,
  'false', 'status=banned is blocked');
SELECT _assert_eq(public.check_email_allowed('suspended@example.com')::text,
  'false', 'status=suspended is blocked');
SELECT _assert_eq(public.check_email_allowed('blocked@example.com')::text,
  'false', 'status=blocked is blocked');

-- (5) deny_list exact email (active) → blocked.
INSERT INTO public.deny_list (pattern, pattern_type, active)
  VALUES ('spammer@example.com', 'email', true);
SELECT _assert_eq(public.check_email_allowed('spammer@example.com')::text,
  'false', 'active deny_list email is blocked');

-- (6) An INACTIVE deny_list row is ignored (the ban was lifted).
INSERT INTO public.deny_list (pattern, pattern_type, active)
  VALUES ('pardoned@example.com', 'email', false);
SELECT _assert_eq(public.check_email_allowed('pardoned@example.com')::text,
  'true', 'inactive deny_list row does not block');

-- (7) An EXPIRED deny_list row is ignored.
INSERT INTO public.deny_list (pattern, pattern_type, active, expires_at)
  VALUES ('temp@example.com', 'email', true, now() - interval '1 day');
SELECT _assert_eq(public.check_email_allowed('temp@example.com')::text,
  'true', 'expired deny_list row does not block');

-- (8) deny_list whole-domain match blocks any address on that domain.
INSERT INTO public.deny_list (pattern, pattern_type, active)
  VALUES ('baddomain.com', 'email_domain', true);
SELECT _assert_eq(public.check_email_allowed('anyone@baddomain.com')::text,
  'false', 'email_domain deny blocks the whole domain');
SELECT _assert_eq(public.check_email_allowed('someoneelse@baddomain.com')::text,
  'false', 'email_domain deny blocks a second address on the domain');
-- but not a different domain.
SELECT _assert_eq(public.check_email_allowed('anyone@gooddomain.com')::text,
  'true', 'other domains are not blocked by an email_domain rule');

-- (9) email_domain pattern tolerant of a leading '@'.
INSERT INTO public.deny_list (pattern, pattern_type, active)
  VALUES ('@atdomain.com', 'email_domain', true);
SELECT _assert_eq(public.check_email_allowed('x@atdomain.com')::text,
  'false', 'email_domain pattern with a leading @ still matches');

-- (10) Input is trimmed and case-insensitive on both allow_list and deny_list.
SELECT _assert_eq(public.check_email_allowed('  BANNED@EXAMPLE.COM  ')::text,
  'false', 'blocking is case-insensitive and trims the input');

-- (11) A block on one email does not leak to a different email.
SELECT _assert_eq(public.check_email_allowed('unrelated@example.com')::text,
  'true', 'a block on other rows does not affect an unrelated email');

SELECT '✓ check_email_allowed invariants pass' AS result;
ROLLBACK;
