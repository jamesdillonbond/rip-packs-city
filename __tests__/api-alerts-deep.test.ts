import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Deep test for /api/alerts — drives the GET market-data enrichment
// (editions→fmv_current→badge_editions join + evalTriggered + discount math),
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
      // Reads fmv_current (latest-per-edition), not raw fmv_snapshots: the raw
      // table keeps ~87 daily rows per edition and PostgREST caps every read at
      // 1000, so a JS first-wins dedupe over it covered only ~11 editions
      // (deep-audit D27). One row per edition here, as the view returns.
      fmv_current: {
        data: [
          { edition_id: "ed1", fmv_usd: 100 },
          { edition_id: "ed2", fmv_usd: 100 },
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

  it("500s when the delete errors", async () => {
    state.user = { id: "u1" }
    install({ fmv_alerts: { data: null, error: { message: "del boom" } } })
    const res = await DELETE(getReq("https://t/api/alerts?id=al1"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("del boom")
  })
})

describe("GET /api/alerts — remaining branches", () => {
  it("evaluates price_below / fmv_below / unknown-type (default) triggers", async () => {
    state.user = { id: "u1", email: "a@b.co" }
    install({
      fmv_alerts: {
        data: [
          { id: "p1", owner_key: "u1", edition_key: "1:1", collection_id: TS, alert_type: "price_below", threshold: 80 },
          { id: "f1", owner_key: "u1", edition_key: "2:2", collection_id: TS, alert_type: "fmv_below", threshold: 200 },
          { id: "d1", owner_key: "u1", edition_key: "3:3", collection_id: TS, alert_type: "weird", threshold: 5 },
        ],
        error: null,
      },
      editions: {
        data: [
          { id: "e1", external_id: "1:1", collection_id: TS },
          { id: "e2", external_id: "2:2", collection_id: TS },
          { id: "e3", external_id: "3:3", collection_id: TS },
        ],
        error: null,
      },
      fmv_current: {
        data: [
          { edition_id: "e1", fmv_usd: 100 },
          { edition_id: "e2", fmv_usd: 100 },
          { edition_id: "e3", fmv_usd: 100 },
        ],
        error: null,
      },
      badge_editions: { data: [{ edition_key: "1:1", low_ask: 70 }], error: null },
    })

    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    const p1 = body.find((r: { id: string }) => r.id === "p1")
    expect(p1.currently_triggered).toBe(true) // ask 70 <= 80
    expect(p1.current_discount_pct).toBe(30)
    const f1 = body.find((r: { id: string }) => r.id === "f1")
    expect(f1.currently_triggered).toBe(true) // fmv 100 <= 200
    expect(f1.current_discount_pct).toBeNull() // no ask
    const d1 = body.find((r: { id: string }) => r.id === "d1")
    expect(d1.currently_triggered).toBe(false) // unknown type → default false
  })

  it("include_inactive=1 lists inactive alerts too (skips the active filter)", async () => {
    state.user = { id: "u1", email: "a@b.co" }
    install({
      fmv_alerts: {
        data: [{ id: "x1", owner_key: "u1", edition_key: "1:1", collection_id: TS, alert_type: "fmv_below", threshold: 5, active: false }],
        error: null,
      },
      editions: { data: [], error: null },
      fmv_current: { data: [], error: null },
      badge_editions: { data: [], error: null },
    })
    const res = await GET(getReq("https://t/api/alerts?include_inactive=1"))
    expect(res.status).toBe(200)
    expect((await res.json())).toHaveLength(1)
  })

  // ⚠ INVERTED 2026-08-22, not deleted. This asserted `error === "read boom"` —
  // i.e. it pinned the /api/sets LEAK as the contract: the driver's own message
  // handed to the client. Under the disk-IO band that string is Postgres's
  // "canceling statement due to statement timeout". A passing test asserting a
  // promise is what holds that promise in place, so the assertion is reversed
  // rather than removed.
  it("fails without leaking the driver message when the fmv_alerts read errors", async () => {
    state.user = { id: "u1", email: "a@b.co" }
    install({ fmv_alerts: { data: null, error: { message: "read boom" } } })
    const res = await GET(getReq())
    expect(res.ok).toBe(false)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain("read boom")
    // Still says SOMETHING actionable — silence would be its own defect.
    expect(typeof body.error).toBe("string")
    expect(body.error.length).toBeGreaterThan(0)
  })
})

describe("POST /api/alerts — channel / collection / email / error branches", () => {
  it("telegram channel keeps notification_email null and stores a valid collection_id + names", async () => {
    state.user = { id: "u1", email: "me@x.com" }
    install({ fmv_alerts: { data: { id: "al2" }, error: null } })
    const coll = "dee28451-5d62-409e-a1ad-a83f763ac070"
    const res = await POST(
      bodyReq({
        edition_key: "9:9",
        alert_type: "fmv_above",
        threshold: 12,
        channel: "telegram",
        collection_id: coll,
        player_name: "Dame",
        set_name: "Base",
      }),
    )
    expect(res.status).toBe(201)
    const up = state.writes["fmv_alerts"]?.find((w) => w.method === "upsert")
    expect(up?.rows[0]).toMatchObject({
      owner_key: "u1",
      channel: "telegram",
      notification_email: null,
      collection_id: coll,
      player_name: "Dame",
      set_name: "Base",
    })
  })

  it("uses an explicit valid notification_email over the session email", async () => {
    state.user = { id: "u1", email: "me@x.com" }
    install({ fmv_alerts: { data: { id: "al3" }, error: null } })
    const res = await POST(
      bodyReq({ edition_key: "9:9", alert_type: "fmv_below", threshold: 5, channel: "email", notification_email: "target@y.com" }),
    )
    expect(res.status).toBe(201)
    const up = state.writes["fmv_alerts"]?.find((w) => w.method === "upsert")
    expect(up?.rows[0]).toMatchObject({ notification_email: "target@y.com", player_name: null, set_name: null })
  })

  it("400s on an invalid JSON body", async () => {
    state.user = { id: "u1", email: "a@b.co" }
    install({ fmv_alerts: { data: null, error: null } })
    const badReq = { nextUrl: new URL("https://t/api/alerts"), json: async () => { throw new Error("x") } } as never
    const res = await POST(badReq)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  // ⚠ INVERTED 2026-08-22 — same reason as the GET case above.
  it("fails without leaking the driver message when the upsert errors", async () => {
    state.user = { id: "u1", email: "a@b.co" }
    install({ fmv_alerts: { data: null, error: { message: "upsert boom" } } })
    const res = await POST(bodyReq({ edition_key: "9:9", alert_type: "fmv_below", threshold: 5 }))
    expect(res.ok).toBe(false)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain("upsert boom")
    expect(typeof body.error).toBe("string")
  })
})

describe("PATCH /api/alerts — remaining branches", () => {
  it("400s on an invalid JSON body", async () => {
    state.user = { id: "u1" }
    install({ fmv_alerts: { data: null, error: null } })
    const badReq = { nextUrl: new URL("https://t/api/alerts"), json: async () => { throw new Error("x") } } as never
    expect((await PATCH(badReq)).status).toBe(400)
  })

  it("400s when id is missing", async () => {
    state.user = { id: "u1" }
    install({ fmv_alerts: { data: null, error: null } })
    const res = await PATCH(bodyReq({ active: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("id is required")
  })

  it("500s when the update errors", async () => {
    state.user = { id: "u1" }
    install({ fmv_alerts: { data: null, error: { message: "patch boom" } } })
    const res = await PATCH(bodyReq({ id: "al1", active: true }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("patch boom")
  })
})
