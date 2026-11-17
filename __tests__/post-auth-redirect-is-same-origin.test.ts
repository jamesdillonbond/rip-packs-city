import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { safeRedirectPath, DEFAULT_POST_AUTH_PATH } from "@/lib/auth/safe-redirect"

// ─────────────────────────────────────────────────────────────────────────────
// Post-sign-in redirects: a functional bug and an open redirect, in one chain.
//
// ── WHAT WAS BROKEN ─────────────────────────────────────────────────────────
// 1. FUNCTIONAL. `/api/auth/request-magic-link` already carried the login
//    page's `next` into the emailed callback as `?redirect=`, and
//    `AuthConfirmClient` never read it — it hard-coded `router.replace("/")`.
//    It only LOOKED fine because "/" bounces a signed-in user to /dashboard, so
//    the common case worked and every deep link lost its destination. A
//    campaign link to `/dashboard#trophy` landed on the dashboard top.
//
// 2. 🚨 SECURITY. The one sanitiser in the chain was
//    `redirect.startsWith("/")`. That is NOT a same-origin test:
//    `//evil.example/x` starts with "/" and resolves to
//    `https://evil.example/x`. On an auth callback that is an open redirect —
//    a link that really is ours, really signs the victim in, then lands them on
//    someone else's page already authenticated.
//
// ⭐ SECOND INSTANCE OF THIS DISGUISE IN ONE DAY. The first was trophy-slab art
// (`lib/profile/trophy-thumbnail.ts`, same session). Same bug, different
// surface, found independently. **The lesson is not "remember to check for //"
// — it is that "starts with /" was never a security check.**
// ─────────────────────────────────────────────────────────────────────────────

describe("safeRedirectPath", () => {
  it("keeps ordinary same-origin paths, including the deep link this exists for", () => {
    for (const p of ["/dashboard", "/dashboard#trophy", "/profile/qa0903", "/insights?tab=deals", "/"]) {
      expect(safeRedirectPath(p), p).toBe(p)
    }
  })

  it("REJECTS the protocol-relative disguise — the open redirect", () => {
    expect(safeRedirectPath("//evil.example/x")).toBeNull()
    expect(safeRedirectPath("//evil.example")).toBeNull()
    // Backslash sits in the authority position for a browser's URL parser.
    expect(safeRedirectPath("/\\evil.example")).toBeNull()
  })

  it("REJECTS absolute URLs and non-path schemes", () => {
    expect(safeRedirectPath("https://evil.example/x")).toBeNull()
    expect(safeRedirectPath("http://evil.example/x")).toBeNull()
    expect(safeRedirectPath("javascript:alert(1)")).toBeNull()
    expect(safeRedirectPath("dashboard")).toBeNull()
  })

  it("REJECTS control characters, which truncate a value inside a header or href", () => {
    // The injection shape: a newline in the MIDDLE, splitting the value so the
    // tail lands in a new header or attribute.
    expect(safeRedirectPath("/dashboard\nLocation: https://evil.example")).toBeNull()
    // ⓘ A SPACE is deliberately allowed. I asserted it should be rejected and
    // the code was right: 0x20 is not a control character, it cannot split a
    // header, and a browser percent-encodes it. Banning it would reject a valid
    // path for no gain. Recorded so the next reader does not "fix" it.
    expect(safeRedirectPath("/dash board")).toBe("/dash board")
  })

  it("TRIMS surrounding whitespace rather than rejecting it", () => {
    // Recorded because I asserted the opposite first and the CODE was right:
    // a trailing CRLF is stripped by `.trim()`, leaving an ordinary path with
    // nothing dangerous left in it. The injection risk is a control character
    // in the MIDDLE, which the case above covers. Rejecting a trailing newline
    // would break a legitimate redirect for no security gain.
    expect(safeRedirectPath("/dashboard\r\n")).toBe("/dashboard")
    expect(safeRedirectPath("  /dashboard  ")).toBe("/dashboard")
  })

  it("handles absent and non-string input", () => {
    expect(safeRedirectPath(null)).toBeNull()
    expect(safeRedirectPath(undefined)).toBeNull()
    expect(safeRedirectPath(42 as never)).toBeNull()
    expect(safeRedirectPath("")).toBeNull()
  })

  it("exports a fallback for callers to land on", () => {
    expect(DEFAULT_POST_AUTH_PATH.startsWith("/")).toBe(true)
    expect(safeRedirectPath(DEFAULT_POST_AUTH_PATH)).toBe(DEFAULT_POST_AUTH_PATH)
  })
})

describe("both ends of the chain use the sanitiser", () => {
  // A perfect helper is inert if either side keeps its own weaker check. Both
  // are pinned because the WRITE side puts the value into an emailed link and
  // the READ side navigates to it — either alone leaves the hole open.
  it("the confirm page reads ?redirect= and sanitises it", () => {
    const src = readFileSync(join(process.cwd(), "app/auth/confirm/AuthConfirmClient.tsx"), "utf8")
    expect(src).toMatch(/safeRedirectPath\(requested\)/)
    // …and no longer hard-codes the destination.
    expect(src).not.toMatch(/router\.replace\("\/"\)/)
    // ⚠ It must read the QUERY string: `params` in that effect is the HASH,
    // where Supabase's implicit-flow token lives. Reading `redirect` from the
    // fragment would silently always be null and the fix would be inert.
    expect(src).toMatch(/new URLSearchParams\(window\.location\.search\)\.get\("redirect"\)/)
  })

  it("the magic-link route sanitises before it emails the link", () => {
    const src = readFileSync(join(process.cwd(), "app/api/auth/request-magic-link/route.ts"), "utf8")
    expect(src).toMatch(/const safeRedirect = safeRedirectPath\(redirect\)/)
    expect(src).not.toMatch(/redirect\.startsWith\("\/"\)/)
  })
})
