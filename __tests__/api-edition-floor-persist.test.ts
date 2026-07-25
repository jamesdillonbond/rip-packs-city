import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { installFetchMock, jsonRoute, type InstalledFetchMock } from "./helpers/route-harness"

// The `persist` half of /api/edition-floor — `?persist=1` on GET and
// `{persist:true}` on POST — which writes the resolved cross-market floor back
// into fmv_snapshots. The read half already has an integration test; this one is
// entirely undriven, and it is the half that WRITES to the FMV table.
//
// Three invariants carry the weight:
//   1. **ULTIMATE editions are skipped.** fmv_snapshots ULTIMATE rows are owned
//      exclusively by recalc_ultimate_fmv (the ultimate-v1 algo, which excludes
//      special-serial sales). A floor-only persist landing on one would overwrite
//      a deliberately different pricing model — the same ownership rule the
//      allday-fmv-populate writer enforces with its own double guard.
//   2. **Only TODAY's snapshots are deleted** before re-insert, so historical
//      rows accumulate. A delete without the date bound would erase an edition's
//      whole price history to record one floor.
//   3. The whole thing is **fire-and-forget and non-fatal** — the caller gets its
//      floor whether or not the write lands.

const state = vi.hoisted(() => ({
  editionRows: [] as unknown[],
  existingSnapshots: [] as unknown[],
  inserted: [] as unknown[][],
  deletes: [] as Array<{ ins: unknown; gte: [string, string] | null }>,
  selects: [] as string[],
  throwOn: null as string | null,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      if (state.throwOn === table) throw new Error(`${table} client exploded`)
      let mode: "select" | "delete" | "insert" = "select"
      const del = { ins: null as unknown, gte: null as [string, string] | null }
      const b: Record<string, unknown> = {}
      const self = () => b
      b.select = (cols: string) => { state.selects.push(cols); mode = "select"; return self() }
      b.delete = () => { mode = "delete"; state.deletes.push(del); return self() }
      b.insert = (rows: unknown[]) => { mode = "insert"; state.inserted.push(rows); return Promise.resolve({ error: null }) }
      b.in = (_c: string, v: unknown) => { if (mode === "delete") del.ins = v; return self() }
      b.gte = (c: string, v: string) => { if (mode === "delete") del.gte = [c, v]; return self() }
      b.order = () => self()
      ;(b as { then: unknown }).then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          table === "editions"
            ? { data: state.editionRows, error: null }
            : { data: state.existingSnapshots, error: null },
        ).then(res)
      return b
    },
  }),
}))

const { GET, POST } = await import("@/app/api/edition-floor/route")

function tsFloor(lowestAsk: number | null) {
  return {
    data: {
      searchEditions: {
        data: { searchSummary: { data: { data: [{ setID: "1", playID: "2", lowestAsk, forSaleCount: 3, circulationCount: 100 }] } } },
      },
    },
  }
}
const flowtyEmpty = { nfts: [] }

let harness: InstalledFetchMock | null = null
function stubVenues(ask: number | null = 12) {
  harness = installFetchMock([
    jsonRoute("nbatopshot.com", tsFloor(ask)),
    jsonRoute("flowty.io", flowtyEmpty),
    { match: () => true, respond: () => ({ json: {} }) },
  ])
}

/** The persist is fire-and-forget; let its promise chain settle. */
const flush = () => new Promise((r) => setTimeout(r, 0))

const insertedRows = () => state.inserted.flat() as Array<Record<string, unknown>>

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"
  state.editionRows = []
  state.existingSnapshots = []
  state.inserted = []
  state.deletes = []
  state.selects = []
  state.throwOn = null
})
afterEach(() => {
  harness?.restore()
  harness = null
})

describe("edition-floor persist — the write path", () => {
  it("carries the latest snapshot forward, stamps the three ask columns, and drops the old id", async () => {
    state.editionRows = [{ id: "ed-uuid", collection_id: "col-uuid", external_id: "1:2", tier: "RARE" }]
    state.existingSnapshots = [
      { id: "old-snap", edition_id: "ed-uuid", fmv_usd: 40, confidence: "HIGH", computed_at: "2026-07-20" },
      // An older row for the same edition must lose to the newest.
      { id: "older", edition_id: "ed-uuid", fmv_usd: 1, confidence: "LOW", computed_at: "2026-01-01" },
    ]
    stubVenues(12)

    const res = await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2&persist=1"))
    expect(res.status).toBe(200)
    await flush()

    const row = insertedRows()[0]
    expect(row).toMatchObject({
      edition_id: "ed-uuid",
      collection_id: "col-uuid",
      cross_market_ask: 12,
      top_shot_ask: 12,
      algo_version: "1.2.1",
      // The rest of the newest snapshot rides along so the row stays complete.
      fmv_usd: 40,
      confidence: "HIGH",
    })
    // A carried-forward primary key would collide on insert.
    expect(row.id).toBeUndefined()
  })

  it("SKIPS an ULTIMATE edition — those fmv_snapshots rows belong to recalc_ultimate_fmv", async () => {
    state.editionRows = [
      { id: "ult", collection_id: "c", external_id: "1:2", tier: "ultimate" }, // case-insensitive
    ]
    stubVenues(12)

    await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2&persist=1"))
    await flush()

    expect(insertedRows()).toHaveLength(0)
    // And it is excluded from the DELETE set too, so an ultimate-v1 row is never
    // even read or removed.
    expect(state.deletes[0]?.ins).toEqual([])
  })

  it("deletes only TODAY's snapshots so historical rows accumulate", async () => {
    state.editionRows = [{ id: "ed-uuid", collection_id: "c", external_id: "1:2", tier: "COMMON" }]
    stubVenues(12)

    await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2&persist=1"))
    await flush()

    const [col, iso] = state.deletes[0].gte!
    expect(col).toBe("computed_at")
    // Midnight UTC of the current day — not "everything".
    expect(iso.endsWith("T00:00:00.000Z")).toBe(true)
    expect(iso.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10))
  })

  it("writes nothing when there is no floor to record", async () => {
    state.editionRows = [{ id: "ed-uuid", collection_id: "c", external_id: "1:2", tier: "COMMON" }]
    stubVenues(null) // no Top Shot ask, no Flowty listings -> crossMarketFloor null

    const body = await (await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2&persist=1"))).json()
    await flush()

    expect(body.crossMarketFloor).toBeNull()
    expect(insertedRows()).toHaveLength(0)
    expect(state.deletes).toHaveLength(0) // early-out before any DB work
  })

  it("writes nothing when the edition key resolves to no editions row", async () => {
    state.editionRows = []
    stubVenues(12)
    await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2&persist=1"))
    await flush()
    expect(insertedRows()).toHaveLength(0)
    expect(state.deletes).toHaveLength(0)
  })

  it("does not persist at all without the flag", async () => {
    state.editionRows = [{ id: "ed-uuid", collection_id: "c", external_id: "1:2", tier: "COMMON" }]
    stubVenues(12)
    await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2"))
    await flush()
    expect(state.selects).toHaveLength(0)
  })

  it("still answers 200 when the persist throws (fire-and-forget, non-fatal)", async () => {
    state.throwOn = "editions"
    stubVenues(12)
    const res = await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2&persist=1"))
    expect(res.status).toBe(200)
    expect((await res.json()).crossMarketFloor).toBe(12)
    await flush()
    expect(insertedRows()).toHaveLength(0)
  })
})

describe("edition-floor POST — batch persist + body guards", () => {
  it("400s on an unparseable body", async () => {
    harness = installFetchMock([])
    const bad = { json: async () => { throw new Error("not json") }, nextUrl: new URL("https://t/api/edition-floor") } as unknown as NextRequest
    const res = await POST(bad)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid body")
  })

  it("returns an empty result set for a non-array or empty editionKeys, touching nothing", async () => {
    harness = installFetchMock([])
    for (const body of [{}, { editionKeys: "1:2" }, { editionKeys: [] }]) {
      const req = { json: async () => body, nextUrl: new URL("https://t/api/edition-floor") } as unknown as NextRequest
      expect(await (await POST(req)).json()).toEqual({ results: [] })
    }
    expect(harness.calls).toHaveLength(0)
  })

  it("persists every resolved floor in the batch when persist:true", async () => {
    state.editionRows = [
      { id: "ed-a", collection_id: "c", external_id: "1:2", tier: "COMMON" },
      { id: "ed-b", collection_id: "c", external_id: "3:4", tier: "RARE" },
    ]
    stubVenues(12)
    const req = {
      json: async () => ({ editionKeys: ["1:2", "3:4"], persist: true }),
      nextUrl: new URL("https://t/api/edition-floor"),
    } as unknown as NextRequest

    const body = await (await POST(req)).json()
    await flush()

    expect(body.results).toHaveLength(2)
    // Both editions are keyed off the SAME stubbed venue floor, so both persist.
    expect(insertedRows().map((r) => r.edition_id).sort()).toEqual(["ed-a", "ed-b"])
  })
})
