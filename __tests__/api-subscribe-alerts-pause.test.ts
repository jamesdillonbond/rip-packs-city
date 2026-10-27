import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// app/api/subscribe/alerts-pause/route.ts (2026-10-24): a GET never changes
// anything (mail scanners fetch links); a POST with a valid token pauses the
// EMAIL channel only (and, since 2026-10-27, the FMV alerts' fallback address); a bad token
// changes nothing; a failed write says so; nothing on file never claims a pause.
const SECRET = "s".repeat(40)
const updates: Array<{ table: string; patch: unknown; eqs: Array<[string, unknown]> }> = []
let failWrite = false
// Rows each table's UPDATE matches (returned by .select()).
let matched: Record<string, unknown[]> = {}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const rec = { table, patch: null as unknown, eqs: [] as Array<[string, unknown]> }
      const chain: any = {
        update(p: unknown) { rec.patch = p; return chain },
        eq(c: string, v: unknown) { rec.eqs.push([c, v]); return chain },
        in(c: string, v: unknown) { rec.eqs.push([c, v]); return chain },
        select() { return chain },
        then(res: (v: unknown) => void) {
          updates.push(rec)
          res(failWrite ? { data: null, error: { message: "boom" } } : { data: matched[table] ?? [], error: null })
        },
      }
      return chain
    },
  },
}))

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET
  updates.length = 0
  failWrite = false
  matched = { notification_channels: [{ owner_key: "o1" }] }
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
    // Re-pinned 2026-10-27: BOTH stores of the address — the email channel AND the FMV alerts' fallback column.
    const ch = updates.find((u) => u.table === "notification_channels")!
    expect(ch.patch).toEqual({ verified: false })
    expect(ch.eqs).toEqual([["channel", "email"], ["channel_user_id", ["dana@example.com"]]])
    const fmv = updates.find((u) => u.table === "fmv_alerts")!
    expect(fmv.patch).toEqual({ notification_email: null })
    expect(fmv.eqs).toEqual([["notification_email", ["dana@example.com"]]])
    expect(updates).toHaveLength(2)
  })
  it("an address held only as an FMV alert's fallback email is paused too (2026-10-27)", async () => {
    // dispatch_triggered_fmv_alerts falls back to fmv_alerts.notification_email when no verified channel exists.
    matched = { fmv_alerts: [{ id: 1 }] }
    const { POST, url } = await load()
    const res = await POST(new NextRequest(url, { method: "POST" }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("Alert emails paused")
    expect(updates.some((u) => u.table === "fmv_alerts")).toBe(true)
  })
  it("nothing on file for the address never claims a pause", async () => {
    matched = {}
    const { POST, url } = await load()
    const res = await POST(new NextRequest(url, { method: "POST" }))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain("Alert emails paused")
    expect(html).toContain("No alert emails on file")
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
