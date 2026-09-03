// Where a post-sign-in redirect is allowed to send someone.
//
// ⚠ `path.startsWith("/")` IS NOT A SAME-ORIGIN TEST. `//evil.example/x` starts
// with "/" and resolves to `https://evil.example/x` — an absolute URL wearing a
// relative disguise. On an AUTH CALLBACK that is an open redirect: the victim
// clicks a link that really is ours, really does sign them in, and then lands on
// someone else's page already authenticated and primed to trust it.
//
// Browsers also treat a backslash as a slash in the authority position, so
// `/\evil.example` is the same attack with different spelling. Both are rejected.
//
// ⭐ This is the SECOND instance of this exact shape found on 2026-09-02 — the
// first was trophy-slab art (lib/profile/trophy-thumbnail.ts). Same disguise,
// different surface. If a third turns up, the lesson is not "remember to check
// for //", it is that "starts with /" should never have been treated as a
// security check in the first place.

/** The fallback every caller uses when the requested path is not acceptable. */
export const DEFAULT_POST_AUTH_PATH = "/dashboard";

/**
 * Returns a same-origin path safe to navigate to after authentication, or null.
 *
 * Accepts only a rooted path: one leading "/", not followed by another "/" or a
 * backslash. Query and hash are preserved — a campaign deep link like
 * `/dashboard#trophy` is the reason this function exists.
 */
export function safeRedirectPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (!path.startsWith("/")) return null;
  // Authority-position characters: "//" is protocol-relative and "/\" is the
  // same thing as far as a browser's URL parser is concerned.
  if (path.startsWith("//") || path.startsWith("/\\")) return null;
  // A control character can truncate the value inside a header or an href.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return path;
}
