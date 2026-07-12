import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/alerts/channels/verify-email.
// Public email-confirmation link. Missing code/email → an HTML 400 page before
// any claim. On a valid code+email it calls claimChannelLink('email',…) and
// renders a 200 or 400 HTML page by result.ok. Mock @/lib/alerts.claimChannelLink.

const claim: { ok: boolean } = { ok: true }

vi.mock("@/lib/alerts", () => ({
  claimChannelLink: async () => ({ ok: claim.ok }),
}))

import { GET } from "@/app/api/alerts/channels/verify-email/route"

const req = (qs = "") => new NextRequest("https://t/api/alerts/channels/verify-email" + qs)

beforeEach(() => {
  claim.ok = true
})

describe("GET /api/alerts/channels/verify-email", () => {
  it("400s (HTML) when code/email are missing", async () => {
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect(res.headers.get("content-type")).toContain("text/html")
  })

  it("200s (HTML) on a successful claim", async () => {
    const res = await GET(req("?code=abc&email=a@b.co"))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("Email alerts confirmed")
  })

  it("400s (HTML) when the claim fails", async () => {
    claim.ok = false
    const res = await GET(req("?code=abc&email=a@b.co"))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("Couldn't confirm")
  })
})
