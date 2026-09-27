import { describe, it, expect, beforeEach, vi } from "vitest"

// Trophy-case campaign tracking (2026-09-27). /api/profile/trophy writes a
// server-side funnel_events row after a pin or unpin LANDS, carrying user_id and
// the client's session attribution (the public beacon is refused both by the DB
// policy). Pins:
//   · a pin logs trophy_pinned with user_id, slot surface, session + referrer
//   · a FAILED pin logs nothing (no event for a write that did not happen)
//   · a failed event insert does NOT fail the pin
//   · an unpin logs trophy_removed only when a row was actually deleted

const state: {
  user: any
  result: any
  inserts: Array<{ table: string; row: any }>
  insertResult: any
} = { user: null, result: { data: null, error: null }, inserts: [], insertResult: { error: null } }

vi.mock("@/lib/supabase", () => {
  const build = (table: string) => {
    const b: any = {
      select: () => b,
      upsert: () => b,
      delete: () => b,
      eq: () => b,
      not: () => b,
      limit: () => b,
      order: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => state.result,
      insert: (row: any) => {
        state.inserts.push({ table, row })
        return Promise.resolve(state.insertResult)
      },
      then: (resolve: any) => resolve(state.result),
    }
    return b
  }
  const client: any = { from: (t: string) => build(t) }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user) throw new Response("{}", { status: 401 })
    return state.user
  },
}))

import { POST, DELETE } from "@/app/api/profile/trophy/route"

const req = (body: any, ua = "Mozilla/5.0 (Macintosh)") =>
  ({ json: async () => body, headers: new Headers({ "user-agent": ua }) }) as any

const funnel = { sessionId: "sess-1", referrer: "utm_source=x&utm_campaign=trophy-push" }

beforeEach(() => {
  state.user = { id: "u1" }
  state.result = { data: null, error: null }
  state.inserts = []
  state.insertResult = { error: null }
})

const funnelRows = () => state.inserts.filter((i) => i.table === "funnel_events").map((i) => i.row)

describe("/api/profile/trophy — campaign funnel events", () => {
  it("a landed pin logs trophy_pinned with the user, slot and session attribution", async () => {
    state.result = { data: { slot: 3, moment_id: "m3" }, error: null }
    const res = await POST(req({ slot: 3, momentId: "m3", funnel }))
    expect(res.status).toBe(200)
    expect(funnelRows()).toEqual([
      expect.objectContaining({
        event_type: "trophy_pinned",
        user_id: "u1",
        surface: "trophy-case:slot-3",
        session_id: "sess-1",
        referrer: "utm_source=x&utm_campaign=trophy-push",
        bot_ua: false,
      }),
    ])
  })

  it("a FAILED pin logs no event — the row would claim a pin that never happened", async () => {
    state.result = { data: null, error: { message: "upsert boom" } }
    const res = await POST(req({ slot: 1, momentId: "m1", funnel }))
    expect(res.status).toBe(500)
    expect(funnelRows()).toHaveLength(0)
  })

  it("a failed event insert does not fail the pin", async () => {
    state.result = { data: { slot: 1 }, error: null }
    state.insertResult = { error: { message: "policy violation" } }
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await POST(req({ slot: 1, momentId: "m1", funnel }))
    expect(res.status).toBe(200)
    expect((await res.json()).trophy).toMatchObject({ slot: 1 })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("a pin from an old client with no funnel context still logs, with null attribution", async () => {
    state.result = { data: { slot: 2 }, error: null }
    await POST(req({ slot: 2, momentId: "m2" }))
    expect(funnelRows()[0]).toMatchObject({ event_type: "trophy_pinned", session_id: null, referrer: null })
  })

  it("an unpin that removed a row logs trophy_removed", async () => {
    state.result = { data: [{ id: 9 }], error: null }
    const res = await DELETE(req({ slot: 4, funnel }))
    expect(res.status).toBe(200)
    expect(funnelRows()).toEqual([
      expect.objectContaining({ event_type: "trophy_removed", user_id: "u1", surface: "trophy-case:slot-4" }),
    ])
  })

  it("an unpin of an already-empty slot logs nothing", async () => {
    state.result = { data: [], error: null }
    const res = await DELETE(req({ slot: 5, funnel }))
    expect(res.status).toBe(200)
    expect(funnelRows()).toHaveLength(0)
  })

  it("a failed unpin logs nothing", async () => {
    state.result = { data: null, error: { message: "delete boom" } }
    const res = await DELETE(req({ slot: 4, funnel }))
    expect(res.status).toBe(500)
    expect(funnelRows()).toHaveLength(0)
  })
})

describe("the public beacon cannot forge a trophy event", () => {
  it("/api/track-funnel's allowlist carries neither trophy type", async () => {
    const fs = await import("node:fs")
    const src = fs.readFileSync("app/api/track-funnel/route.ts", "utf8")
    const allow = src.slice(src.indexOf("ALLOWED_EVENT_TYPES"), src.indexOf("]);", src.indexOf("ALLOWED_EVENT_TYPES")))
    expect(allow.length).toBeGreaterThan(50)
    expect(allow).toContain('"profile_view"')
    expect(allow).not.toContain("trophy_pinned")
    expect(allow).not.toContain("trophy_removed")
  })
})
