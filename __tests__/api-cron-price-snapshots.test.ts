import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/price-snapshots.
// POST is gated on Bearer INGEST_SECRET_TOKEN and runs SYNCHRONOUSLY — it awaits
// populate_price_snapshots_hourly and spreads the result into the 200 body.
// GET is a public status probe reading price_snapshots_2026 (latest bucket +
// exact count) and deriving staleness_hours. Legs pinned: fail-closed auth, the
// POST success / RPC-error 500 / thrown 500, and GET with a bucket, with no rows,
// and with a throwing read.

const st = {
  rpc: { data: { editions_snapshotted: 42, bucket: "2026-07-12T00:00:00Z" } as { editions_snapshotted: number; bucket: string } | null, error: null as any },
  rpcThrows: false,
  latest: { data: null as any },
  countRes: { count: 0 as any },
  getThrows: false,
  tables: [] as string[],
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      st.tables.push(table)
      if (st.getThrows) throw new Error("pool gone")
      const b: any = {
        select: () => b,
        order: () => b,
        limit: () => b,
        single: async () => st.latest,
        then: (resolve: any) => resolve(st.countRes),
      }
      return b
    },
    rpc: async () => {
      if (st.rpcThrows) throw new Error("rpc exploded")
      return st.rpc
    },
  }),
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/price-snapshots/route")
})

beforeEach(() => {
  st.rpc = { data: { editions_snapshotted: 42, bucket: "2026-07-12T00:00:00Z" }, error: null }
  st.rpcThrows = false
  st.latest = { data: null }
  st.countRes = { count: 0 }
  st.getThrows = false
  st.tables = []
})

describe("POST /api/cron/price-snapshots — auth", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    expect((await mod.POST(makeReq({ method: "POST" }))).status).toBe(401)
  })
  it("401s with a wrong bearer token", async () => {
    expect((await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))).status).toBe(401)
  })
})

describe("POST /api/cron/price-snapshots — synchronous RPC", () => {
  const authed = () => makeReq({ method: "POST", auth: "Bearer test-ingest-token" })

  it("200s spreading the RPC's snapshot summary into the body", async () => {
    const body = await (await mod.POST(authed())).json()
    expect(body.status).toBe("ok")
    expect(body.editions_snapshotted).toBe(42)
    expect(body.bucket).toBe("2026-07-12T00:00:00Z")
  })

  it("500s with the message when the RPC returns an error", async () => {
    st.rpc = { data: null, error: { message: "populate failed" } }
    const res = await mod.POST(authed())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.status).toBe("error")
    expect(body.error).toBe("populate failed")
  })

  it("500s when the RPC throws outright", async () => {
    st.rpcThrows = true
    const res = await mod.POST(authed())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("rpc exploded")
  })

  it("500s when the RPC resolves with null data (no summary to log)", async () => {
    st.rpc = { data: null, error: null }
    expect((await mod.POST(authed())).status).toBe(500)
  })
})

describe("GET /api/cron/price-snapshots — status probe", () => {
  it("reports the total, latest bucket, and derived staleness in hours", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString()
    st.latest = { data: { bucket: twoHoursAgo } }
    st.countRes = { count: 1234 }
    const body = await (await mod.GET()).json()
    expect(body.status).toBe("ok")
    expect(body.total_snapshots).toBe(1234)
    expect(body.latest_bucket).toBe(twoHoursAgo)
    expect(body.staleness_hours).toBe(2)
  })

  it("reads the partitioned parent price_snapshots, not a hardcoded year partition (year-boundary safety)", async () => {
    st.latest = { data: { bucket: new Date().toISOString() } }
    st.countRes = { count: 5 }
    await mod.GET()
    // Both the latest-bucket read and the count read must hit the parent, so the
    // probe keeps working after the hourly writer rolls into price_snapshots_2027.
    expect(st.tables.length).toBeGreaterThan(0)
    expect(st.tables.every((t) => t === "price_snapshots")).toBe(true)
    expect(st.tables).not.toContain("price_snapshots_2026")
  })

  it("reports nulls/zero when no snapshots exist yet", async () => {
    st.latest = { data: null }
    st.countRes = { count: null }
    const body = await (await mod.GET()).json()
    expect(body.total_snapshots).toBe(0)
    expect(body.latest_bucket).toBeNull()
    expect(body.staleness_hours).toBeNull()
  })

  it("500s when the snapshot read throws", async () => {
    st.getThrows = true
    const res = await mod.GET()
    expect(res.status).toBe(500)
    expect((await res.json()).status).toBe("error")
  })
})
