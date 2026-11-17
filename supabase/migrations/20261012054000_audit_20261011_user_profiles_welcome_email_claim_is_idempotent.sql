-- audit_20261011_user_profiles_welcome_email_claim_is_idempotent
-- anon-exec: revoked (claim_welcome_email, record_welcome_email_failure) — two NEW SECDEF writers on
--   user_profiles; REVOKE FROM PUBLIC, anon, authenticated below, GRANT service_role only. The only
--   intended caller is lib/welcome/send-account-welcome.ts through supabaseAdmin.
--
-- WHY. Platform review 2026-10-11 (§4 M2): self-serve signup has been open since 07-20, and the only
-- welcome email (lib/emails/welcome-email.ts) is sent from lib/allow-list/prewarm.ts, reached solely by
-- /api/early-access/submit — a page with zero inbound links. The real funnel (home → /login → magic
-- link → /api/auth/callback or /auth/confirm) never welcomes anyone. A welcome on account creation is
-- TRANSACTIONAL (the account exists) and so does not violate the no-outbound-marketing rule — but it
-- must be sent exactly ONCE per account, from the server, idempotently, and a failed send must never
-- fail a sign-in.
--
-- WHAT THIS ADDS — the idempotency layer, in the database where every creation path can reach it:
--   user_profiles.welcome_state     'pending' | 'sent' | 'pre_existing'   (NOT NULL, default 'pending')
--   user_profiles.welcome_sent_at   when a send SUCCEEDED (NULL until then — never stamped by a failure)
--   user_profiles.welcome_error     the last send failure, if any (cleared by a later success)
--   user_profiles.welcome_attempts  how many claims have been made (bounds retries at 3)
--
--   claim_welcome_email(p_user_id)            → boolean. Atomically moves 'pending' → 'sent' and stamps
--                                               welcome_sent_at, ONLY for a row that exists, is 'pending',
--                                               and has fewer than 3 attempts. Returns true exactly once per
--                                               account (a concurrent second caller loses the row lock race
--                                               and gets false). An unknown id returns false: no profile row,
--                                               no account, no email.
--   record_welcome_email_failure(p_user_id, e) → void. Reverts a claim whose send FAILED ('sent' → 'pending',
--                                               welcome_sent_at → NULL, welcome_error = e) so a later sign-in
--                                               can retry — but only a claim made in the last 10 minutes and
--                                               only while the row says 'sent'; the attempts counter is NOT
--                                               reverted, so three failures end the retries.
--
-- ⚠ BACKFILL, and why it is in THIS migration and not a later one: every profile row that exists when
-- this applies belongs to an account that was created WITHOUT a welcome. If those stayed 'pending', the
-- first sign-in after the send is wired would mail every existing collector a "welcome" — a welcome to
-- someone who has been here for months is the account-level false claim CLAUDE.md names as a worst
-- sub-class. They are stamped 'pre_existing' here, so they can never be claimed. ⚠ The backfill is a
-- separate statement from ADD COLUMN on purpose: a row created between ADD COLUMN and the UPDATE in a
-- later deploy would be fine either way (it is 'pending' and genuinely new), but keeping the two
-- statements adjacent in one migration closes the window to the transaction.
--
-- NOT WIRED YET. This migration + lib/welcome/send-account-welcome.ts implement the idempotent column
-- and helper. The call into the auth paths is deliberately NOT made in this batch: the profile row is
-- created by TWO upserts (app/api/auth/callback/route.ts touchUserProfile and /api/profile/touch), neither
-- of which knows whether the row was newly created, and /api/profile/** is under another engineer's
-- edit. With this layer in place the wiring is one call per path: after the upsert,
-- `void sendAccountWelcomeOnce({ userId, email })` — the claim decides, idempotently, whether anything
-- is sent, so BOTH paths may call it and no account can be welcomed twice.
--
-- user_profiles RLS: enabled, policies user_profiles_auth_insert / _auth_update only (read live
-- 2026-10-11). The new columns are written ONLY through the two SECDEF functions; a signed-in user's own
-- UPDATE policy would let them flip welcome_state on their own row, which can at worst suppress or
-- re-enable their OWN welcome — acceptable, and noted.
--
-- REVERT: DROP FUNCTION public.claim_welcome_email(uuid); DROP FUNCTION public.record_welcome_email_failure(uuid, text);
--   ALTER TABLE public.user_profiles DROP COLUMN welcome_state, DROP COLUMN welcome_sent_at,
--   DROP COLUMN welcome_error, DROP COLUMN welcome_attempts;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS welcome_state text NOT NULL DEFAULT 'pending'
    CONSTRAINT user_profiles_welcome_state_check CHECK (welcome_state IN ('pending', 'sent', 'pre_existing')),
  ADD COLUMN IF NOT EXISTS welcome_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS welcome_error text,
  ADD COLUMN IF NOT EXISTS welcome_attempts integer NOT NULL DEFAULT 0;

-- Every account that exists at apply time was created without a welcome and must never receive one.
UPDATE public.user_profiles
   SET welcome_state = 'pre_existing'
 WHERE welcome_state = 'pending';

COMMENT ON COLUMN public.user_profiles.welcome_state IS
'Welcome-email state machine: pending (new account, not yet welcomed) | sent (claim_welcome_email stamped it; welcome_sent_at set) | pre_existing (account predates the welcome email, 2026-10-11 backfill — never claimable). Written only by claim_welcome_email / record_welcome_email_failure.';
COMMENT ON COLUMN public.user_profiles.welcome_sent_at IS
'When the welcome send was CLAIMED by claim_welcome_email. Reverted to NULL by record_welcome_email_failure if that send failed, so NULL + pending means never successfully sent.';
COMMENT ON COLUMN public.user_profiles.welcome_error IS
'Last welcome send failure (Resend/HTTP/network message, truncated), or NULL. Diagnostic only.';
COMMENT ON COLUMN public.user_profiles.welcome_attempts IS
'Number of welcome claims made for this account. claim_welcome_email refuses at 3, so a persistently failing send stops retrying.';

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

REVOKE ALL ON FUNCTION public.claim_welcome_email(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_welcome_email(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.record_welcome_email_failure(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_welcome_email_failure(uuid, text) TO service_role;

COMMENT ON FUNCTION public.claim_welcome_email(uuid) IS
'Atomic once-per-account claim for the transactional welcome email: pending → sent, stamps welcome_sent_at, increments welcome_attempts; true exactly once per account (false for unknown ids, pre_existing rows, already-sent rows, or ≥ 3 attempts). Caller: lib/welcome/send-account-welcome.ts (service_role). Pinned: supabase/tests/claim_welcome_email.sql.';
COMMENT ON FUNCTION public.record_welcome_email_failure(uuid, text) IS
'Reverts a welcome claim whose send FAILED (sent → pending, welcome_sent_at → NULL, welcome_error set) so the next sign-in may retry; only within 10 minutes of the claim and only while the row reads sent. Attempts are not reverted. Caller: lib/welcome/send-account-welcome.ts.';
