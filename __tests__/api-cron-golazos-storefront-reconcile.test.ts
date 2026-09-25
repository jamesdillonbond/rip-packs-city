import { describe, it, expect, beforeEach, vi } from "vitest"

// Route-integration test for /api/cron/golazos-storefront-reconcile.
// The planning rules are pinned in golazos-storefront-reconcile.test.ts; this
// file pins the I/O around them: fail-closed auth, a whole run through the
// real planner (sellers read → storefront walk → writes → closes → log), and
// the failure shapes that must never read as success — a failed walk closes
// nothing for that seller and makes the run ok=false.

const GZ = "06248cc4-b85f-47cd-af67-1855d14acd75"
const SELLER = "0x709dac865ee203c5"

type Op = { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  ops: [] as Op[],
  logs: [] as any[],
  tables: {} as Record<string, any[]>,
  flow: null as null | ((body: any) => { ok: boolean; status: number; text: string }),
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: async () => {} }))

function chain(table: string) {
  const rec: Op = { table, op: "select", filters: [] }
  const c: any = {
    select: () => c,
    eq: (k: string, v: unknown) => (rec.filters.push([k, v]), c),
    gte: () => c,
    not: () => c,
    order: () => c,
    is: (k: string, v: unknown) => (rec.filters.push([k, v]), c),
    in: (k: string, v: unknown) => (rec.filters.push([k, v]), c),
    range: (from: number) => ((rec as any).from = from, c),
    upsert: (payload: unknown) => ((rec.op = "upsert"), (rec.payload = payload), c),
    update: (payload: unknown) => ((rec.op = "update"), (rec.payload = payload), c),
    then: (resolve: any) => {
      state.ops.push(rec)
      if (rec.op === "upsert") return resolve({ error: null })
      if (rec.op === "update") {
        const ids = (rec.filters.find(([k]) => k === "listing_resource_id")?.[1] as string[]) ?? []
        return resolve({ data: ids.map((id) => ({ listing_resource_id: id })), error: null })
      }
      const from = (rec as any).from ?? 0
      return resolve({ data: from > 0 ? [] : state.tables[table] ?? [], error: null })
    },
  }
  return c
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (t: string) => chain(t),
    rpc: async (_name: string, args: any) => (state.logs.push(args), { error: null }),
  },
}))

process.env.CRON_SECRET = "gz-cron"
process.env.INGEST_SECRET_TOKEN = "gz-ingest"

import { makeReq } from "./cron-req-helper"
const mod = await import("@/app/api/cron/golazos-storefront-reconcile/route")

function cdcListings(rows: Array<Record<string, string>>): string {
  const value = rows.map((r) => ({
    type: "Dictionary",
    value: Object.entries(r).map(([k, v]) => ({ key: { type: "String", value: k }, value: { type: "String", value: v } })),
  }))
  return JSON.stringify(Buffer.from(JSON.stringify({ type: "Array", value })).toString("base64"))
}

async function runAfter() {
  for (const cb of state.afterCbs.splice(0)) await cb()
}

beforeEach(() => {
  state.afterCbs = []
  state.ops = []
  state.logs = []
  state.tables = {
    cached_listings_v2: [
      {
        listing_resource_id: 216603793360707, // a bigint arrives from PostgREST as a JSON number
        source: "direct_v2",
        flow_id: "5",
        edition_id: null,
        collection_id: GZ,
        seller_address: SELLER,
        price_usd: 3,
        currency: "DUC",
        custom_id: null,
        listed_at: "2026-08-01T00:00:00Z",
        expiry_at: null,
        completed_at: null,
        completed_status: null,
        block_height: 1,
        tx_hash: "t",
        event_index: 0,
      },
    ],
    sales: [{ seller_address: SELLER.toUpperCase().replace("0X", "0x") }],
    editions: [{ id: "ed-89", external_id: "89" }],
  }
  state.flow = () => ({
    ok: true,
    status: 200,
    text: cdcListings([
      { listingId: "NEW", nftId: "7", expiry: "9999999999", salePrice: "85.00000000", vault: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault", live: "1", editionId: "89", serial: "64" },
      { listingId: "216603793360707", nftId: "5", expiry: "9999999999", salePrice: "3.0", vault: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault", live: "0" },
    ]),
  })
  vi.stubGlobal("fetch", async (_url: string, init: any) => {
    const r = state.flow!(JSON.parse(init.body))
    return { ok: r.ok, status: r.status, text: async () => r.text }
  })
})

describe("/api/cron/golazos-storefront-reconcile — auth", () => {
  it("401s without an authorization header and with a wrong token (fail-closed)", async () => {
    expect((await mod.GET(makeReq({ method: "GET" }))).status).toBe(401)
    expect((await mod.GET(makeReq({ method: "GET", auth: "Bearer nope" }))).status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("accepts CRON_SECRET (what Vercel cron sends) and INGEST_SECRET_TOKEN, answering 202", async () => {
    expect((await mod.GET(makeReq({ method: "GET", auth: "Bearer gz-cron" }))).status).toBe(202)
    expect((await mod.POST(makeReq({ auth: "Bearer gz-ingest" }))).status).toBe(202)
  })
})

describe("/api/cron/golazos-storefront-reconcile — a run", () => {
  it("inserts the listing the indexer never saw, closes the ghost, and logs counts that match", async () => {
    await mod.GET(makeReq({ method: "GET", auth: "Bearer gz-cron" }))
    await runAfter()

    const upsert = state.ops.find((o) => o.op === "upsert")
    expect(upsert?.payload).toEqual([
      expect.objectContaining({ listing_resource_id: "NEW", source: "storefront_v2", edition_id: "ed-89", price_usd: 85 }),
    ])
    const close = state.ops.find((o) => o.op === "update")
    expect(close?.payload).toMatchObject({ completed_status: "ghosted" })
    expect(close?.filters).toContainEqual(["listing_resource_id", [216603793360707]])
    expect(close?.filters).toContainEqual(["completed_at", null])

    const log = state.logs.at(-1)
    expect(log.p_pipeline).toBe("golazos-storefront-reconcile")
    expect(log.p_ok).toBe(true)
    expect(log.p_rows_found).toBe(2)
    expect(log.p_rows_written).toBe(2)
    // the mixed-case sales seller and the listing seller are one seller
    expect(log.p_extra).toMatchObject({ sellers_known: 1, sellers_walked: 1, inserted: 1, ghosted: 1, closed: 1 })
  })

  it("a failed storefront walk closes nothing for that seller and makes the run ok=false", async () => {
    state.flow = () => ({ ok: false, status: 500, text: "boom" })
    await mod.GET(makeReq({ method: "GET", auth: "Bearer gz-cron" }))
    await runAfter()

    expect(state.ops.filter((o) => o.op === "update" || o.op === "upsert")).toHaveLength(0)
    const log = state.logs.at(-1)
    expect(log.p_ok).toBe(false)
    expect(log.p_error).toMatch(/storefront walk\(s\) failed/)
    expect(log.p_extra).toMatchObject({ sellers_walked: 0, sellers_walk_errors: 1 })
  })

  it("a failed sellers read makes the run ok=false instead of walking nobody and reporting success", async () => {
    // Force the sales read to error.
    const { supabaseAdmin } = (await import("@/lib/supabase")) as any
    const realFrom = supabaseAdmin.from
    supabaseAdmin.from = (t: string) =>
      t === "sales"
        ? { select: () => ({ eq: () => ({ gte: () => ({ not: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: "timeout" } }) }) }) }) }) }) }
        : realFrom(t)
    try {
      await mod.GET(makeReq({ method: "GET", auth: "Bearer gz-cron" }))
      await runAfter()
    } finally {
      supabaseAdmin.from = realFrom
    }
    const log = state.logs.at(-1)
    expect(log.p_ok).toBe(false)
    expect(log.p_error).toMatch(/sale sellers read failed: timeout/)
    expect(state.ops.filter((o) => o.op === "update" || o.op === "upsert")).toHaveLength(0)
  })
})
