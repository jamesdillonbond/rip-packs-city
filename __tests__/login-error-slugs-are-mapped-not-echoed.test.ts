import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loginErrorCopy, LOGIN_ERROR_FALLBACK } from "@/lib/auth/login-error-copy"

// ─────────────────────────────────────────────────────────────────────────────
// `/login?error=<value>` — the value is ATTACKER-SUPPLIED, and it used to be
// rendered.
//
// `LoginClient` mapped two known values and fell through to the raw query-string
// value for everything else. Two consequences, and the second is the real one:
//
//   1. Real slugs reached users. The auth chain sets `auth_failed`,
//      `missing_token`, `session_failed` (AuthConfirmClient) and `missing_code`
//      (api/auth/callback) — so somebody whose magic link expired was shown the
//      string "session_failed".
//
//   2. 🚨 ANY text in the query string rendered inside our own error banner, in
//      our voice, on our login page. React escapes it, so this is not XSS — it
//      is worse in the way that matters for a login form:
//      `/login?error=Your+account+was+locked.+Call+555-0100` is a phishing
//      message wearing Rip Packs City's UI.
//
// ⭐ **The defect was not the ugly slug. It was that an UNKNOWN value was
// rendered at all** — which is why the fix is an allowlist with a generic
// fallback rather than a prettifier, and why the assertions below are about
// what is NOT rendered.
// ─────────────────────────────────────────────────────────────────────────────

/** Every value the auth chain actually redirects with. Grepped, not guessed. */
const REAL_SLUGS = ["auth_failed", "missing_token", "session_failed", "missing_code"]

describe("/login?error= is mapped, never echoed", () => {
  it("renders human copy for every slug the auth chain sets — and never the slug", () => {
    for (const slug of REAL_SLUGS) {
      const copy = loginErrorCopy(slug)
      expect(copy, slug).toBeTruthy()
      // The property, as an ABSENCE: the machine string must not survive into
      // the message. This is what a user was shown.
      expect(copy, `"${slug}" leaked into its own copy`).not.toContain(slug)
      expect(copy).not.toMatch(/_/)
    }
  })

  it("REFUSES to render an unknown value — the phishing vector", () => {
    const injected = "Your account was locked. Call 555-0100 to restore it."
    const copy = loginErrorCopy(injected)
    expect(copy).toBe(LOGIN_ERROR_FALLBACK)
    expect(
      copy,
      "attacker-supplied text must not reach our error banner",
    ).not.toContain("555-0100")
  })

  it("keeps access_revoked null so the closed-beta banner is not doubled", () => {
    // It has a dedicated banner above the form, deliberately, so that the
    // messaging survives a resubmit. Copy here would render it twice.
    expect(loginErrorCopy("access_revoked")).toBeNull()
  })

  it("NO-CHANGE CONTROL: the pre-existing allowlist_unavailable copy is unchanged", () => {
    // This message was already correct. A refactor that quietly reworded it
    // would be an unrequested product change.
    expect(loginErrorCopy("allowlist_unavailable")).toBe(
      "Sign-in service is temporarily unavailable. Please try again in a moment.",
    )
  })

  it("no error param renders nothing", () => {
    expect(loginErrorCopy(null)).toBeNull()
    expect(loginErrorCopy(undefined)).toBeNull()
    expect(loginErrorCopy("")).toBeNull()
  })

  it("the client uses the mapper instead of the raw param", () => {
    // A perfect mapper is inert if LoginClient still falls through to
    // `urlErrorRaw` — which is exactly the line that shipped.
    const src = readFileSync(join(process.cwd(), "app/login/LoginClient.tsx"), "utf8")
    expect(src).toMatch(/const urlError = loginErrorCopy\(urlErrorRaw\)/)
    expect(src).not.toMatch(/:\s*urlErrorRaw\s*$/m)
  })

  it("every slug the auth chain sets is actually in the map — grepped from source", () => {
    // ⚠ Guards against the map going stale: a new redirect slug that nobody adds
    // here degrades to the generic fallback, which is safe but vaguer than it
    // needs to be. This surfaces that rather than letting it pass silently.
    const files = [
      "app/auth/confirm/AuthConfirmClient.tsx",
      "app/api/auth/callback/route.ts",
    ].map((f) => readFileSync(join(process.cwd(), f), "utf8"))
    const found = new Set<string>()
    for (const src of files) {
      for (const m of src.matchAll(/searchParams\.set\("error",\s*"([a-z_]+)"\)/g)) found.add(m[1])
      for (const m of src.matchAll(/\/login\?error=([a-z_]+)/g)) found.add(m[1])
    }
    // The walk must have found something, or this assertion is vacuous.
    expect(found.size).toBeGreaterThanOrEqual(3)
    for (const slug of found) {
      expect(loginErrorCopy(slug), `"${slug}" is set by the auth chain but not mapped`).not.toBe(
        LOGIN_ERROR_FALLBACK,
      )
    }
  })
})
