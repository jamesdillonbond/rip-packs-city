// What `/login?error=<slug>` is allowed to say.
//
// ── WHY A MAP AND NOT A FALLTHROUGH ─────────────────────────────────────────
// `LoginClient` read `params.get("error")` and, for anything it did not
// recognise, rendered the RAW VALUE in its error banner. Two problems, and the
// second is the one that matters:
//
// 1. Real slugs reached users verbatim. `auth_failed`, `missing_token`,
//    `session_failed` and `missing_code` are the four the auth chain actually
//    sets (app/auth/confirm/AuthConfirmClient.tsx, app/api/auth/callback), and
//    a person who clicked an expired magic link was shown the string
//    "session_failed".
//
// 2. 🚨 THE VALUE COMES FROM THE QUERY STRING, so ANY text an attacker put
//    there was rendered inside our own error banner, in our voice, on our
//    login page. React escapes it, so this is not XSS — it is worse in the way
//    that matters for a login form: a crafted link like
//    `/login?error=Your+account+was+locked.+Call+555-0100+to+restore+it` is a
//    phishing message wearing Rip Packs City's UI. **The defect is not the
//    slug, it is that an UNKNOWN value was rendered at all.**
//
// ⚠ So this is an allowlist with a generic fallback, never a prettifier. A
// future slug that nobody adds here degrades to honest generic copy; it must
// never degrade to echoing itself.

/** Generic, honest, and actionable — used for every unrecognised value. */
export const LOGIN_ERROR_FALLBACK =
  "Something went wrong signing you in. Request a new link and try again."

const COPY: Record<string, string> = {
  // The confirm/callback chain. All four mean roughly "that link did not work",
  // and the user's next action is identical, so they say so plainly rather than
  // leaking which internal step failed.
  auth_failed: "That sign-in link didn't work. It may have expired — request a new one below.",
  missing_token: "That sign-in link looks incomplete. Request a new one below.",
  session_failed: "We couldn't finish signing you in. Request a new link and try again.",
  missing_code: "That sign-in link looks incomplete. Request a new one below.",
  // Pre-existing copy, kept verbatim so this refactor changes no message that
  // was already correct.
  allowlist_unavailable: "Sign-in service is temporarily unavailable. Please try again in a moment.",
}

/**
 * Human copy for a `?error=` value, or null when there is nothing to show.
 *
 * ⚠ `access_revoked` returns null ON PURPOSE: it has a dedicated banner above
 * the form so the closed-beta messaging survives a resubmit. Returning copy
 * here would render it twice.
 */
export function loginErrorCopy(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw === "access_revoked") return null;
  return COPY[raw] ?? LOGIN_ERROR_FALLBACK;
}
