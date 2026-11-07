import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/alerts/channels/verify-email — the public
// email-confirmation link.
//
// 2026-11-07 review: the GET used to CLAIM the one-time code, so a mail
// provider's link scanner prefetching the message spent it and the collector's
// own click read "expired or already used". GET now renders a Confirm button
// and claims nothing; the button's POST claims. The old "GET 200s on a
// successful claim" test pinned the defect and is INVERTED below.

const claim: { result: { ok?: boolean; error?: string } | null; calls: number } = { result: { ok: true }, calls: 0 }

vi.mock("@/lib/alerts", () => ({
  claimChannelLink: async () => {
    claim.calls++
    return claim.result
  },
}))

import { GET, POST } from "@/app/api/alerts/channels/verify-email/route"

const URL_ = "https://t/api/alerts/channels/verify-email"
const get = (qs = "") => new NextRequest(URL_ + qs)
const post = (fields: Record<string, string>) =>
  new NextRequest(URL_, {
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  })

beforeEach(() => {
  claim.result = { ok: true }
  claim.calls = 0
})

describe("GET /api/alerts/channels/verify-email", () => {
  it("400s (HTML) when code/email are missing", async () => {
    const res = await GET(get())
    expect(res.status).toBe(400)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(claim.calls).toBe(0)
  })

  it("INVERTED: a GET (what a link scanner sends) claims NOTHING and never says confirmed", async () => {
    const res = await GET(get("?code=abc&email=a@b.co"))
    const html = await res.text()
    expect(claim.calls).toBe(0)
    expect(html).not.toContain("Email alerts confirmed")
    expect(res.status).toBe(200)
    expect(html).toMatch(/<form method="post" action="\/api\/alerts\/channels\/verify-email"/)
    expect(html).toContain('name="code" value="abc"')
    expect(html).toContain('name="email" value="a@b.co"')
  })

  it("escapes the echoed code and email", async () => {
    const res = await GET(get('?code=%22%3E%3Cscript%3E&email=x%22%3Ey@b.co'))
    const html = await res.text()
    expect(html).not.toContain("<script>")
    expect(html).toContain("&quot;&gt;&lt;script&gt;")
  })
})

describe("POST /api/alerts/channels/verify-email", () => {
  it("200s (HTML) on a successful claim", async () => {
    const res = await POST(post({ code: "abc", email: "A@B.co" }))
    expect(res.status).toBe(200)
    expect(claim.calls).toBe(1)
    expect(await res.text()).toContain("Email alerts confirmed")
  })

  it("400s (HTML) when the code is refused", async () => {
    claim.result = { ok: false, error: "invalid_or_expired" }
    const res = await POST(post({ code: "abc", email: "a@b.co" }))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("expired or already been used")
  })

  it("a FAILED claim call is a retryable 503 that keeps the button, never 'expired'", async () => {
    claim.result = { error: "server_error" }
    const res = await POST(post({ code: "abc", email: "a@b.co" }))
    const html = await res.text()
    expect(res.status).toBe(503)
    expect(html).not.toContain("expired or already been used")
    expect(html).toContain('name="code" value="abc"')
  })

  it("400s without a claim when the form is missing fields", async () => {
    const res = await POST(post({ code: "abc" }))
    expect(res.status).toBe(400)
    expect(claim.calls).toBe(0)
  })
})
