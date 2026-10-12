// lib/auth/bearer-secret.ts
//
// Compare a request's `Authorization` header against one or more shared
// secrets named by env var — FAILING CLOSED when a secret is unset or empty.
//
// ⛔ The shape this replaces, `auth !== \`Bearer ${process.env.X}\``, fails OPEN:
// with X unset the expected value is the literal string "Bearer undefined", so a
// caller sending exactly that header passes. The OR form
// (`a === \`Bearer ${process.env.X}\` || a === \`Bearer ${process.env.Y}\``) opens if
// EITHER secret is unset. Latent while every var is set in production, but a
// renamed or dropped env var would silently open the route (2026-10-09 audit).
// __tests__/bearer-secret-fails-closed-ratchet.test.ts bans the bare form.

/**
 * Constant-time string equality. A plain `===` returns at the first differing
 * character, so the time a 401 takes leaks how many leading bytes the attacker
 * has right — and the cron/ingest prefixes are exempt from the rate limiter, so
 * an attacker gets an unmetered oracle (platform review 2026-10-11, S4). Pure
 * JS, not `crypto.timingSafeEqual`, because this module is imported by routes
 * that may run on the Edge runtime where node:crypto is absent. The loop always
 * walks the full expected length; a length mismatch is folded into the result
 * instead of returned early.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

/**
 * Constant-time check of a BARE token (no "Bearer " prefix) against one or more
 * secrets named by env var — the `?token=` query-string form some cron-job.org
 * entries and admin probes use. Same fail-closed and compare-every-secret
 * rules as bearerMatches. ⚠ Accepting a token from the query string at all is
 * a known weakness (it lands in logs and referrers); this helper exists so the
 * routes that must keep it for their configured callers at least compare it
 * in constant time.
 */
export function tokenMatches(presented: string | null | undefined, ...envNames: string[]): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false
  let matched = false
  for (const name of envNames) {
    const secret = process.env[name]
    if (typeof secret === "string" && secret.length > 0) {
      matched = constantTimeEqual(presented, secret) || matched
    }
  }
  return matched
}

export function bearerMatches(header: string | null | undefined, ...envNames: string[]): boolean {
  if (typeof header !== "string" || header.length === 0) return false
  // Every configured secret is compared, even after a match, so the number of
  // comparisons does not depend on which secret (if any) the caller holds.
  let matched = false
  for (const name of envNames) {
    const secret = process.env[name]
    if (typeof secret === "string" && secret.length > 0) {
      matched = constantTimeEqual(header, `Bearer ${secret}`) || matched
    }
  }
  return matched
}
