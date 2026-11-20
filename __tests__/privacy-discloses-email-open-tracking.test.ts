// 2026-11-20 (Trevor approved): Resend open tracking was turned ON for the sending
// domain. The policy had said "We honor Global Privacy Control and Do Not Track"
// with no scope, which an email pixel cannot honour. These pins hold the
// disclosure in place for as long as the pixel is on: if open tracking is turned
// off again, invert them rather than deleting them.
import { describe, it, expect } from "vitest"
import fs from "node:fs"

const page = fs.readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ")
const footer = fs.readFileSync("components/SiteFooter.tsx", "utf8")

describe("/privacy discloses the email open image", () => {
  it("says emails carry an image that reports opens, and through whom", () => {
    expect(page).toMatch(/emails we send carry a small image that tells us, through Resend, whether a message was opened/)
  })
  it("does not claim the browser signals reach email, and says how to avoid the image", () => {
    expect(page).toMatch(/Do Not Track signals on the site/)
    expect(page).toMatch(/cannot reach an email/)
    expect(page).toMatch(/turn off remote images/)
    expect(page).not.toMatch(/We honor Global Privacy Control and Do Not Track signals \(see Cookies below\)/)
  })
  it("states that links are not click-tracked (click tracking stays OFF: it would wrap sign-in links)", () => {
    expect(page).toMatch(/We do not use click-tracking links/)
  })
  it("flags the change where the policy promises to: on a surface the home page renders", () => {
    expect(footer).toMatch(/href="\/privacy"[^>]*>PRIVACY \(UPDATED NOV 20\)</)
  })
})
