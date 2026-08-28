import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/track-funnel. Public funnel-event sink
// with an event_type allowlist. An unknown/blank event_type is rejected quietly
// (200 { ok: false }); an allowed type awaits a service-role insert → { ok: true }.
// Mocks @supabase/supabase-js.

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
}))

import { POST } from "@/app/api/track-funnel/route"

const req = (body: any, bad = false) =>
  ({ json: async () => { if (bad) throw new Error("bad"); return body } }) as any

describe("POST /api/track-funnel", () => {
  it("rejects an unknown event_type with 200 { ok: false }", async () => {
    const res = await POST(req({ eventType: "not-allowed" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(false)
  })

  it("accepts an allowlisted event_type", async () => {
    const res = await POST(req({ eventType: "home_view", surface: "home" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("500s on a malformed body", async () => {
    expect((await POST(req(null, true))).status).toBe(500)
  })
})

// ── R23: bot classification ─────────────────────────────────────────────────
// The funnel was ~100% machine traffic with no way to say so: 15,803 events over
// 15,689 distinct sessions, 0.34% firing more than once, 99.82% null referrer.
// collection_view rose 82 -> 7,738/day with zero change in wallet_paste, signups
// or sign-ins. Any read of "views" as traction was wrong by ~3 orders of
// magnitude.
describe("R23 — bot_ua classification", () => {
  it("flags user-agents that self-identify as automated", async () => {
    const { isBotUserAgent } = await import("@/app/api/track-funnel/route")
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "curl/8.4.0",
      "python-requests/2.31.0",
      "GPTBot/1.0",
      "HeadlessChrome/120.0.0.0",
      // Deep-audit run 4 (2026-08-27): 250 Lightpanda/1.0 events in 7d were
      // passing the human filter — a headless browser whose UA carries neither
      // "bot" nor "headless".
      "Lightpanda/1.0",
      "Java/1.8.0_181",
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(true)
    }
  })

  it("does NOT flag real browsers — the control that keeps this honest", async () => {
    // Over-flagging would delete the real traffic from every future reading,
    // which is the same defect in the opposite direction and far harder to spot
    // because the number just looks small.
    const { isBotUserAgent } = await import("@/app/api/track-funnel/route")
    for (const ua of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(false)
    }
  })

  it("treats a missing user-agent as UNKNOWN, not as a bot", async () => {
    const { isBotUserAgent } = await import("@/app/api/track-funnel/route")
    expect(isBotUserAgent(null)).toBe(false)
    expect(isBotUserAgent(undefined)).toBe(false)
    expect(isBotUserAgent("")).toBe(false)
  })

  it("still answers 200 when the request carries no headers at all", async () => {
    // A route that throws while LOGGING an arrival turns an analytics gap into a
    // 500 for the visitor. The harness's request object has no `headers`, which
    // is exactly the shape that caught this.
    const res = await POST(req({ eventType: "home_view", sessionId: "s1" }))
    expect(res.status).toBe(200)
  })
})
