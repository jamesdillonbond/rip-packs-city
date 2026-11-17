import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

// The half of the silent-alert-failure class that the deep suite cannot reach.
//
// `app/api/sentinel/route.ts` reads TELEGRAM_BOT_TOKEN / RESEND_API_KEY at
// MODULE SCOPE, and the deep suite sets them before importing the route — so it
// can only ever exercise the CONFIGURED path. This file imports the route with
// them absent, which is the case that used to vanish entirely: both push sites
// sat behind `if (TOKEN && CHAT_ID)`, so an unconfigured channel produced NO
// entry at all. Absence reads identically to "no notification was needed".
//
// Observed 2026-08-30: pipeline-sentinel run 33283636751 reported
// `"notifications":["telegram-FAILED"]` on a CRITICAL sweep. That told a reader
// an alert was lost and nothing about why — and had the token merely been
// missing, it would have told them nothing at all.

process.env.INGEST_SECRET_TOKEN = "test-token"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.test"
process.env.SUPABASE_SERVICE_ROLE_KEY = "k"
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID
delete process.env.RESEND_API_KEY
delete process.env.ALERT_EMAIL

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from() {
      const b: Record<string, unknown> = {}
      const self = new Proxy(b, {
        get: (_t, k) =>
          k === "then"
            ? (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 })
            : () => self,
      })
      return self
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}))

const { POST } = await import("@/app/api/sentinel/route")

const post = () =>
  new NextRequest("https://www.rippackscity.com/api/sentinel", {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
  })

describe("an UNCONFIGURED alert channel is reported, not silently skipped", () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    // Nothing should reach the network; if it does, the test should notice.
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("names both channels as FAILED:not_configured rather than omitting them", async () => {
    const report = await (await POST(post())).json()
    const notes = report.notifications as string[]
    // ⚠ The assertion is on the ABSENCE OF THE FALSE IMPRESSION, not merely the
    // presence of a string: a reader must not be able to conclude "no alert was
    // needed" from a list that is silent about a channel that cannot deliver.
    expect(notes.some((n) => n.startsWith("telegram-FAILED"))).toBe(true)
    expect(notes.find((n) => n.startsWith("telegram-FAILED"))).toContain("not_configured")
    expect(notes.some((n) => n.startsWith("email-FAILED"))).toBe(true)
    expect(notes.find((n) => n.startsWith("email-FAILED"))).toContain("not_configured")
    // And it must not claim delivery on either.
    expect(notes).not.toContain("telegram")
    expect(notes).not.toContain("email")
  })

  it("does not attempt a send it cannot make", async () => {
    await POST(post())
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const urls = calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.includes("api.telegram.org"))).toEqual([])
    expect(urls.filter((u) => u.includes("api.resend.com"))).toEqual([])
  })
})
