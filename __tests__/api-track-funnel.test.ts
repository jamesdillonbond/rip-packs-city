import { describe, it, expect, vi } from "vitest"

// 2026-10-10 (#180 item 4): the anonymous-beacon budget. Allowed unless a test
// says otherwise; the refusal case asserts the event is dropped.
const beacon = vi.hoisted(() => ({ allowed: true, calls: [] as string[] }))
vi.mock("@/lib/abuse/anon-rate", () => ({
  anonTelemetryAllowed: async (_h: unknown, route: string) => { beacon.calls.push(route); return beacon.allowed },
}))

// Route integration test for POST /api/track-funnel. Public funnel-event sink
// with an event_type allowlist. An unknown/blank event_type is rejected quietly
// (200 { ok: false }); an allowed type awaits a service-role insert → { ok: true }.
// Mocks @supabase/supabase-js.

const db = vi.hoisted(() => ({ rows: [] as any[], error: null as null | { message: string } }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({ insert: async (row: any) => { db.rows.push(row); return { error: db.error } } }),
  }),
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

  it("stores a well-formed visitorId and drops a malformed one", async () => {
    db.rows.length = 0
    await POST(req({ eventType: "home_view", visitorId: "11111111-2222-3333-4444-555555555555" }))
    await POST(req({ eventType: "home_view", visitorId: "<script>alert(1)</script>" }))
    expect(db.rows[0].visitor_id).toBe("11111111-2222-3333-4444-555555555555")
    expect(db.rows[1].visitor_id).toBeNull()
  })

  it("does not report ok:true when the insert failed (write-side honesty)", async () => {
    db.error = { message: "insert failed" }
    try {
      const res = await POST(req({ eventType: "home_view" }))
      expect(res.status).toBe(200) // a beacon caller never retries; status stays 200
      expect((await res.json()).ok).toBe(false)
    } finally {
      db.error = null
    }
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

  // 2026-09-30: ~80% of "human" funnel rows over 14 days were Playwright's
  // iPhone 13 descriptor — old iOS token, bundled-WebKit Safari version.
  it("flags an iOS/Safari pairing no real device can send (Playwright device emulation)", async () => {
    const { isBotUserAgent } = await import("@/app/api/track-funnel/route")
    for (const ua of [
      // The exact production UA (Playwright 1.61 iPhone 13).
      "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1",
      // Playwright 1.63 iPhone 13 and iPhone SE.
      "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/26.6 Mobile/14E304 Safari/602.1",
      "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(true)
    }
  })

  it("does NOT flag real iPhones, including the frozen iOS 26 UA", async () => {
    const { isBotUserAgent } = await import("@/app/api/track-funnel/route")
    for (const ua of [
      // Real iOS 26 Safari: Apple froze the OS token at 18_x while Version is 26.
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
      // A genuine iOS 15.0 Safari — indistinguishable from old Playwright, so it stays human.
      "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
      // Chrome on iOS and in-app webviews carry no Version/ token.
      "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.0",
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
