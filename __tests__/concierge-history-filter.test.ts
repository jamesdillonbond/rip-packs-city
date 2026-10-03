import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { mineFilter } from "@/lib/concierge/history-filter"

// DELETE /api/support-chat/history (2026-10-03): the only row selector is the
// cookie-derived identity. These pin that the PostgREST filter it builds
// cannot be widened by the identity's own characters.

describe("mineFilter", () => {
  it("quotes the email and username and escapes LIKE wildcards", () => {
    expect(mineFilter("a@b.com", "webz_80")).toBe('user_email.ilike."a@b.com",owner_key.eq."webz_80"')
    expect(mineFilter("a@b.com", null)).toBe('user_email.ilike."a@b.com"')
    // A % or _ in the email must match literally, never as a wildcard. The
    // LIKE escape is a backslash, and inside a PostgREST double-quoted value a
    // backslash is itself escaped — so the wire form carries two.
    expect(mineFilter("a%@b.com", null)).toBe('user_email.ilike."a\\\\%@b.com"')
    expect(mineFilter("a_b@c.com", null)).toBe('user_email.ilike."a\\\\_b@c.com"')
  })
  it("cannot be broken out of with reserved characters", () => {
    const f = mineFilter('x",owner.neq."nobody', 'y),(user_email.neq.z')
    // Both injected fragments stay inside their quoted values: the quotes are
    // escaped, and the clause separators , ( ) never reach PostgREST bare.
    expect(f).toBe('user_email.ilike."x\\",owner.neq.\\"nobody",owner_key.eq."y),(user_email.neq.z"')
    // Exactly two top-level clauses (split on an unquoted comma).
    expect(f.match(/"(?:[^"\\]|\\.)*"/g)).toHaveLength(2)
  })
})

describe("the history route is cookie-scoped and never deletes logged feedback", () => {
  const src = readFileSync(join(process.cwd(), "app", "api", "support-chat", "history", "route.ts"), "utf8")
  it("401s without a session email, deletes only feedback_type IS NULL rows, anonymises the rest", () => {
    expect(src).toContain('{ error: "Sign in to delete your chat history." }, { status: 401 }')
    expect(src).toContain('.delete()\n      .is("feedback_type", null)')
    expect(src).toContain('.not("feedback_type", "is", null)')
    expect(src).not.toMatch(/req\.(json|nextUrl|body)/)
    expect(src).not.toContain("searchParams")
  })
})
