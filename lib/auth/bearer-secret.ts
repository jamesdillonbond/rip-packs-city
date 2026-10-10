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

export function bearerMatches(header: string | null | undefined, ...envNames: string[]): boolean {
  if (typeof header !== "string" || header.length === 0) return false
  for (const name of envNames) {
    const secret = process.env[name]
    if (typeof secret === "string" && secret.length > 0 && header === `Bearer ${secret}`) return true
  }
  return false
}
