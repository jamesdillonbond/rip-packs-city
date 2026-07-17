import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Deep test for /api/alerts — drives the GET market-data enrichment
// (editions→fmv_snapshots→badge_editions join + evalTriggered + discount math),
// the owner-scoped POST upsert body, and the PATCH/DELETE toggle+scope branches
// the shallow test (auth + create/list) doesn't reach. owner_key must always be
// the session id, never a body field — pinned via the instrumented write.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  user: null as null | { id: string; email?: string },
  writes: {} as Record<string, { method: string; rows: Record<string, unknown>[] }[]>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    return state.user
  },
}))

import { GET, POST, PATCH, DELETE } from "@/app/api/alerts/route"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function install(fixtures: Record<string, unknown>) {
  const spy = makeInstrumentedSupabaseFixture(fixtures as never)
  state.sb = spy.fixture
  state.writes = spy.writes
}

const getReq = (u = "https://t/api/alerts") => ({ nextUrl: new URL(u) }) as never
const bodyReq = (body: unknown, u = "https://t/api/alerts") =>
  ({ nextUrl: new URL(u), json: async () => body }) as never

beforeEach(() => {
  state.sb = null
  state.user = null
  state.writes = {}
})

describe("GET /api/alerts — market-data enrichment", () => {
  it("joins FMV + ask onto each alert and evaluates the trigger + discount", async () => {
    state.user = { id: "u1", email: "a@b.co" }
    install({
      fmv_alerts: {
        data: [
          { id: "a1", owner_key: "u1", edition_key: "3:45", collection_id: TS, alert_type: "fmv_above", threshold: 50 },
          { id: "a2", owner_key: "u1", edition_key: "9:99", collection_id: TS, alert_type: "discount_above", threshold: 20 },
        ],
        error: null,
      },
      editions: {
        data: [
          { id: "ed1", external_id: "3:45", collection_id: TS },
          { id: "ed2", external_id: "9:99", collection_id: TS },
        ],
        error: null,
      },
      fmv_snapshots: {
        data: [
          { edition_id: "ed1", fmv_usd: 100, computed_at: "2026-07-17T02:00:00Z" },
          { edition_id: "ed2", fmv_usd: 100, computed_at: "2026-07-17T02:00:00Z" },
        ],
        error: null,
      },
      badge_editions: { data: [{ edition_key: "9:99", low_ask: 70 }], error: null },
    })

    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()

    const a1 = body.find((r: { id: string }) => r.id === "a1")
    expect(a1.fmv).toBe(100)
    expect(a1.currently_triggered).toBe(true) // fmv_above 50, fmv 100
    expect(a1.current_discount_pct).toBeNull() // no ask for 3:45

    const a2 = body.find((r: { id: string }) => r.id === "a2")
    expect(a2.fmv).toBe(100)
    expect(a2.low_ask).toBe(70)
    expect(a2.current_discount_pct).toBe(30) // (100-70)/100
    expect(a2.currently_triggered).toBe(true) // discount 30 >= 20
  })
})

describe("POST /api/alerts — owner-scoped create", () => {
  it("upserts with owner_key = session id, default TS collection, and the session email target", async () => {
    state.user = { id: "u1", email: "me@x.com" }
    install({ fmv_alerts: { data: { id: "al1", edition_key: "3:45" }, error: null } })

    const res = await POST(
      bodyReq({ edition_key: "3:45", alert_type: "fmv_below", threshold: 5, owner_key: "ATTACKER" }),
    )
    expect(res.status).toBe(201)
    const up = state.writes["fmv_alerts"]?.find((w) => w.method === "upsert")
    expect(up?.rows[0]).toMatchObject({
      owner_key: "u1", // session-resolved, body owner_key ignored
      edition_key: "3:45",
      collection_id: TS,
      alert_type: "fmv_below",
      threshold: 5,
      channel: "email",
      notification_email: "me@x.com",
      active: true,
    })
  })

  it("400s on a non-positive threshold", async () => {
    state.user = { id: "u1", email: "a@b.co" }
    install({ fmv_alerts: { data: null, error: null } })
    const res = await POST(bodyReq({ edition_key: "3:45", alert_type: "fmv_below", threshold: 0 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("threshold must be a positive number")
  })
})

describe("PATCH /api/alerts — toggle", () => {
  it("400s when active is not a boolean", async () => {
    state.user = { id: "u1" }
    install({ fmv_alerts: { data: null, error: null } })
    const res = await PATCH(bodyReq({ id: "al1", active: "yes" }))
    expect(res.status).toBe(400)
  })

  it("404s when no owned alert matches the id", async () => {
    state.user = { id: "u1" }
    install({ fmv_alerts: { data: null, error: null } })
    const res = await PATCH(bodyReq({ id: "missing", active: false }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("Alert not found")
  })

  it("returns the toggled row on success", async () => {
    state.user = { id: "u1" }
    install({ fmv_alerts: { data: { id: "al1", active: false }, error: null } })
    const res = await PATCH(bodyReq({ id: "al1", active: false }))
    expect(res.status).toBe(200)
    expect((await res.json()).active).toBe(false)
  })
})

describe("DELETE /api/alerts", () => {
  it("400s without an id query param", async () => {
    state.user = { id: "u1" }
    install({ fmv_alerts: { data: [], error: null } })
    expect((await DELETE(getReq("https://t/api/alerts"))).status).toBe(400)
  })

  it("404s when nothing was deleted (row not owned)", async () => {
    state.user = { id: "u1" }
    install({ fmv_alerts: { data: [], error: null } })
    const res = await DELETE(getReq("https://t/api/alerts?id=al1"))
    expect(res.status).toBe(404)
  })

  it("reports the deleted count on success", async () => {
    state.user = { id: "u1" }
    install({ fmv_alerts: { data: [{ id: "al1" }], error: null } })
    const res = await DELETE(getReq("https://t/api/alerts?id=al1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deleted: 1 })
  })
})
