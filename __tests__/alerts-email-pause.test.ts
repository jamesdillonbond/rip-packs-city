import { describe, it, expect } from "vitest"
import { alertEmailPauseToken, verifyAlertEmailPauseToken, alertEmailPauseUrl, decodeEmailParam } from "@/lib/alerts/email-pause"
import { buildEmailMessage } from "@/lib/alerts/format"

const SECRET = "x".repeat(40)

// 2026-10-24: alert emails had no sign-in-free opt-out and no List-Unsubscribe.
describe("alert email pause token", () => {
  it("verifies for the address it was minted for, case-insensitively", () => {
    const t = alertEmailPauseToken("Dana@Example.com", SECRET)
    expect(verifyAlertEmailPauseToken("dana@example.com", t, SECRET)).toBe(true)
  })
  it("does NOT verify for another address or a tampered token", () => {
    const t = alertEmailPauseToken("dana@example.com", SECRET)
    expect(verifyAlertEmailPauseToken("eve@example.com", t, SECRET)).toBe(false)
    expect(verifyAlertEmailPauseToken("dana@example.com", t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"), SECRET)).toBe(false)
    expect(verifyAlertEmailPauseToken("dana@example.com", "", SECRET)).toBe(false)
  })
  it("round-trips the address through the URL", () => {
    const url = new URL(alertEmailPauseUrl("https://www.rippackscity.com", "dana@example.com", SECRET))
    expect(url.pathname).toBe("/api/subscribe/alerts-pause")
    expect(decodeEmailParam(url.searchParams.get("e"))).toBe("dana@example.com")
    expect(verifyAlertEmailPauseToken("dana@example.com", url.searchParams.get("t")!, SECRET)).toBe(true)
  })
  it("rejects a parameter that does not decode to an address", () => {
    expect(decodeEmailParam(Buffer.from("not-an-email").toString("base64url"))).toBeNull()
    expect(decodeEmailParam(null)).toBeNull()
  })
})

describe("buildEmailMessage carries the pause link when given one", () => {
  it("puts it in both the HTML and the plain-text part", () => {
    const { html, text } = buildEmailMessage([], new Date(), { pauseUrl: "https://www.rippackscity.com/api/subscribe/alerts-pause?e=a&t=b" })
    expect(html).toContain("Pause alert emails")
    expect(html).toContain("/api/subscribe/alerts-pause?e=a&amp;t=b")
    expect(text).toContain("Pause alert emails: https://www.rippackscity.com/api/subscribe/alerts-pause?e=a&t=b")
  })
})
