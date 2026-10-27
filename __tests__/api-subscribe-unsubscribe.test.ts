import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/subscribe/unsubscribe.
// Re-pinned 2026-10-27: a GET changes NOTHING (mail scanners and link previews fetch every link, so a GET that
// unsubscribed opted readers out who never clicked) — it renders a confirm button. POST (the button, and RFC 8058
// one-click) unsubscribes, and says so only when the token matched a subscriber.

const state: { error: any; rows: unknown[] | null; updates: number } = { error: null, rows: [{ id: 1 }], updates: 0 }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    update: () => { state.updates++; return b },
    eq: () => b,
    select: async () => ({ data: state.error ? null : state.rows, error: state.error }),
  }
  return { supabaseAdmin: { from: () => b }, supabase: { from: () => b } }
})

import { GET, POST } from "@/app/api/subscribe/unsubscribe/route"

const req = (u: string) => ({ nextUrl: new URL(u), url: u }) as any

beforeEach(() => { state.error = null; state.rows = [{ id: 1 }]; state.updates = 0 })

describe("GET /api/subscribe/unsubscribe", () => {
  it("400s without a token", async () => {
    const res = await GET(req("https://t/api/subscribe/unsubscribe"))
    expect(res.status).toBe(400)
    expect(res.headers.get("Content-Type")).toContain("text/html")
  })

  it("renders a confirm button and changes nothing (a link scanner's fetch must not unsubscribe)", async () => {
    const res = await GET(req("https://t/api/subscribe/unsubscribe?token=abc"))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('method="post"')
    expect(html).not.toContain("You've been unsubscribed")
    expect(state.updates).toBe(0)
  })
})

describe("POST /api/subscribe/unsubscribe (button + RFC 8058 one-click)", () => {
  it("200s on a successful unsubscribe", async () => {
    const res = await POST(req("https://t/api/subscribe/unsubscribe?token=abc"))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("unsubscribed")
    expect(state.updates).toBe(1)
  })

  it("a token matching no subscriber never says 'unsubscribed'", async () => {
    state.rows = []
    const res = await POST(req("https://t/api/subscribe/unsubscribe?token=nope"))
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain("You've been unsubscribed")
  })

  it("500s when the update errors", async () => {
    state.error = { message: "db down" }
    const res = await POST(req("https://t/api/subscribe/unsubscribe?token=abc"))
    expect(res.status).toBe(500)
  })
})
