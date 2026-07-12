import { describe, it, expect } from "vitest"
import {
  buildWelcomeEmailSubject,
  buildWelcomeEmailHtml,
  buildWelcomeEmailText,
} from "@/lib/emails/welcome-email"

// The early-access welcome email builders. Pure string assembly — pin the
// subject + that the html/text render as valid, non-empty documents.

const opts = {
  email: "user@example.com",
  wallet_addr: "0xbd94cade097e50ac",
  username: "trevor",
  collections: ["nba_top_shot"],
}

describe("buildWelcomeEmailSubject", () => {
  it("is the fixed sign-in subject", () => {
    expect(buildWelcomeEmailSubject(opts)).toBe("You're in — sign in to Rip Packs City")
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
})

describe("buildWelcomeEmailText", () => {
  it("returns a non-empty plaintext body", () => {
    const text = buildWelcomeEmailText(opts)
    expect(text.length).toBeGreaterThan(0)
    expect(text.toLowerCase()).toContain("sign in")
  })
})
