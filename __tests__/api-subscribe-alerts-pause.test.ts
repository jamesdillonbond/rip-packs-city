import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// app/api/subscribe/alerts-pause/route.ts (2026-10-24): a GET never changes
// anything (mail scanners fetch links); a POST with a valid token pauses the
// EMAIL channel only; a bad token changes nothing; a failed write says so.
const SECRET = "s".repeat(40)
const updates: Array<{ patch: unknown; eqs: Array<[string, unknown]> }> = []
let failWrite = false

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const rec = { patch: null as unknown, eqs: [] as Array<[string, unknown]> }
      const chain: any = {
        update(p: unknown) { rec.patch = p; return chain },
        eq(c: string, v: unknown) { rec.eqs.push([c, v]); return chain },
        then(res: (v: unknown) => void) { updates.push(rec); res({ error: failWrite ? { message: "boom" } : null }) },
      }
      return chain
    },
  },
}))

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
  updates.length = 0
  failWrite = false
})

async function load() {
  const { GET, POST } = await import("@/app/api/subscribe/alerts-pause/route")
  const { alertEmailPauseUrl } = await import("@/lib/alerts/email-pause")
  return { GET, POST, url: alertEmailPauseUrl("https://www.rippackscity.com", "dana@example.com", SECRET) }
}

describe("alerts-pause route", () => {
  it("GET with a valid link shows a confirm button and writes nothing", async () => {
    const { GET, url } = await load()
    const res = await GET(new NextRequest(url))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('method="post"')
    expect(html).toContain("dana@example.com")
    expect(updates).toHaveLength(0)
  })
  it("POST (one-click) pauses the email channel for that address only", async () => {
    const { POST, url } = await load()
    const res = await POST(new NextRequest(url, { method: "POST", body: "List-Unsubscribe=One-Click" }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("Alert emails paused")
    expect(updates).toHaveLength(1)
    expect(updates[0].patch).toEqual({ verified: false })
    expect(updates[0].eqs).toEqual([["channel", "email"], ["channel_user_id", "dana@example.com"]])
  })
  it("a tampered token is refused and changes nothing", async () => {
    const { POST, url } = await load()
    const bad = url.replace(/t=[^&]+/, "t=AAAA")
    const res = await POST(new NextRequest(bad, { method: "POST" }))
    expect(res.status).toBe(400)
    expect(updates).toHaveLength(0)
  })
  it("a failed write says so instead of claiming the pause", async () => {
    failWrite = true
    const { POST, url } = await load()
    const res = await POST(new NextRequest(url, { method: "POST" }))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("Alert emails paused")
  })
})
