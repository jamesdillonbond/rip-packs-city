import { describe, it, expect } from "vitest"
import {
  buildWelcomeEmailSubject,
  buildWelcomeEmailHtml,
  buildWelcomeEmailText,
  type WelcomeEmailOpts,
} from "@/lib/emails/welcome-email"

// The early-access welcome email builders. Pure string assembly. We pin the
// fixed subject, brand tokens (#e55a4c accent, #0a0a0a bg, logo/login URLs),
// and the ONLY opts-driven variation: prewarm_summary → the per-collection
// status rows (badge variants, empty-summary fallback, non-collection-key
// filtering, HTML escaping). NOTE: WelcomeEmailOpts has no `plan` field and
// username/wallet_addr/collections/email do NOT alter the rendered output —
// this template is intentionally impersonal, which we assert below.

const opts = {
  email: "user@example.com",
  wallet_addr: "0xbd94cade097e50ac",
  username: "trevor",
  collections: ["nba_top_shot"],
}

const ACCENT = "#e55a4c"
const BG = "#0a0a0a"

const fullSummary: WelcomeEmailOpts["prewarm_summary"] = {
  nba_top_shot: "complete",
  nfl_all_day: "in_progress",
  laliga_golazos: "deferred",
  disney_pinnacle: "failed",
  ufc_strike: "skipped",
}

describe("buildWelcomeEmailSubject", () => {
  it("is the fixed sign-in subject", () => {
    expect(buildWelcomeEmailSubject(opts)).toBe("You're in — sign in to Rip Packs City")
  })

  it("ignores opts entirely (same subject for a bare opts object)", () => {
    expect(buildWelcomeEmailSubject({ email: "x@y.z" })).toBe(
      "You're in — sign in to Rip Packs City"
    )
  })
})

describe("buildWelcomeEmailHtml", () => {
  it("renders a full HTML document", () => {
    const html = buildWelcomeEmailHtml(opts)
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("Rip Packs City")
    expect(html).toContain("</html>")
  })

  it("does not throw on a minimal opts object", () => {
    expect(() => buildWelcomeEmailHtml({ email: "x@y.z" })).not.toThrow()
  })

  it("embeds the brand tokens and canonical URLs", () => {
    const html = buildWelcomeEmailHtml(opts)
    expect(html).toContain(ACCENT)
    expect(html).toContain(BG)
    expect(html).toContain("https://www.rippackscity.com/rip-packs-city-logo.png")
    expect(html).toContain("https://www.rippackscity.com/login")
    expect(html).toContain("Welcome to RPC")
  })

  it("has no unresolved template holes (no literal ${ or undefined)", () => {
    const html = buildWelcomeEmailHtml({ email: "x@y.z", prewarm_summary: fullSummary })
    expect(html).not.toContain("${")
    expect(html).not.toContain("undefined")
    expect(html).not.toContain("null")
  })

  it("is impersonal: username/wallet/collections do not change the output", () => {
    const withUser = buildWelcomeEmailHtml({
      email: "a@b.c",
      username: "trevor",
      wallet_addr: "0xbd94cade097e50ac",
      collections: ["nba_top_shot"],
      prewarm_summary: fullSummary,
    })
    const withoutUser = buildWelcomeEmailHtml({
      email: "a@b.c",
      username: null,
      wallet_addr: null,
      collections: null,
      prewarm_summary: fullSummary,
    })
    expect(withUser).toBe(withoutUser)
  })

  it("renders one status row per known collection with its badge label", () => {
    const html = buildWelcomeEmailHtml({ email: "x@y.z", prewarm_summary: fullSummary })
    expect(html).toContain("NBA Top Shot")
    expect(html).toContain("✓ Loaded")
    expect(html).toContain("NFL All Day")
    expect(html).toContain("Loading…")
    expect(html).toContain("LaLiga Golazos")
    expect(html).toContain("Coming soon")
    expect(html).toContain("Disney Pinnacle")
    expect(html).toContain("✗ Failed — we&#39;ll retry") // apostrophe escaped
    expect(html).toContain("UFC Strike")
    expect(html).toContain("Skipped")
  })

  it("shows the empty-state fallback when the summary has no collection keys", () => {
    const html = buildWelcomeEmailHtml({
      email: "x@y.z",
      prewarm_summary: { username_resolution_failure: "true" },
    })
    expect(html).toContain("Your dashboard is ready. Sign in to start exploring.")
    // Internal non-collection metadata keys are filtered out, not rendered.
    expect(html).not.toContain("username_resolution_failure")
  })

  it("falls back to the empty state when prewarm_summary is null/absent", () => {
    const html = buildWelcomeEmailHtml({ email: "x@y.z" })
    expect(html).toContain("Your dashboard is ready. Sign in to start exploring.")
  })

  it("HTML-escapes an unknown status string used as its own badge label", () => {
    const html = buildWelcomeEmailHtml({
      email: "x@y.z",
      prewarm_summary: { nba_top_shot: "<b>hax</b>" },
    })
    expect(html).toContain("&lt;b&gt;hax&lt;/b&gt;")
    expect(html).not.toContain("<b>hax</b>")
  })

  it("defaults a missing collection value to the 'Coming soon' (deferred) badge", () => {
    const html = buildWelcomeEmailHtml({
      email: "x@y.z",
      prewarm_summary: { nba_top_shot: undefined },
    })
    expect(html).toContain("NBA Top Shot")
    expect(html).toContain("Coming soon")
  })
})

describe("buildWelcomeEmailText", () => {
  it("returns a non-empty plaintext body", () => {
    const text = buildWelcomeEmailText(opts)
    expect(text.length).toBeGreaterThan(0)
    expect(text.toLowerCase()).toContain("sign in")
  })

  it("lists collection statuses with the check/cross glyphs stripped", () => {
    const text = buildWelcomeEmailText({ email: "x@y.z", prewarm_summary: fullSummary })
    expect(text).toContain("What's loaded for you:")
    expect(text).toContain("  - NBA Top Shot: Loaded") // ✓ stripped
    expect(text).toContain("  - NFL All Day: Loading…")
    expect(text).toContain("  - LaLiga Golazos: Coming soon")
    expect(text).toContain("  - Disney Pinnacle: Failed — we'll retry") // ✗ stripped
    expect(text).toContain("  - UFC Strike: Skipped")
    expect(text).toContain("Sign in: https://www.rippackscity.com/login")
  })

  it("omits the loaded-list section when there are no collection keys", () => {
    const text = buildWelcomeEmailText({ email: "x@y.z" })
    expect(text).not.toContain("What's loaded for you:")
    expect(text).toContain("Welcome to Rip Packs City")
    expect(text.endsWith("— Rip Packs City · rippackscity.com")).toBe(true)
  })
})
