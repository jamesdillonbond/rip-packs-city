import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { GET_OWNED_MOMENT_IDS } from "@/lib/chains/flow/allday-cadence"

// Route integration test for POST /api/allday-wallet-search.
// The body is validated by a zod schema; an invalid/empty input 400s (with an
// empty rows/summary shell) before any Cadence walk. We ALSO drive the 2xx
// success path: fcl.query is dispatched by cadence script (owned-ids -> [123];
// metadata -> a fixed record) and the getMintedMoment GQL is inert, so a valid
// 0x wallet resolves directly and yields one shaped moment row. FMV enrichment
// reads an empty editions set (Supabase stub in vi.hoisted) and no-ops.

const h = vi.hoisted(() => {
  const state = { tables: {} as Record<string, any[]> }
  const sb: any = {
    from: (t: string) => {
      let table = t
      const b: any = {
        select: () => b,
        in: () => b,
        order: () => b,
        then: (resolve: any) => resolve({ data: state.tables[table] ?? [], error: null }),
      }
      return b
    },
  }
  return { sb, state }
})

const fclState = vi.hoisted(() => ({ ownedIds: [123] as any, meta: null as any, throwOn: null as string | null }))
vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async ({ cadence }: any) => {
      if (fclState.throwOn && String(cadence).includes(fclState.throwOn)) throw new Error("cadence exploded")
      return cadence === GET_OWNED_MOMENT_IDS
        ? fclState.ownedIds
        : (fclState.meta ?? {
            player: "Josh Allen",
            team: "BUF",
            setName: "Base Set",
            setID: "1",
            playID: "2",
            serial: "5",
            mint: "100",
            series: "S1",
            tier: "COMMON",
          })
    },
  },
}))
const gql = vi.hoisted(() => ({ result: {} as any, throws: false }))
vi.mock("@/lib/chains/flow/allday", () => ({
  alldayGraphql: async () => { if (gql.throws) throw new Error("gql down"); return gql.result },
}))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: h.sb }))

import { POST } from "@/app/api/allday-wallet-search/route"

function req(body: any): NextRequest {
  return new NextRequest("https://t/api/allday-wallet-search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/allday-wallet-search", () => {
  it("400s on an empty/invalid body", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.summary.totalMoments).toBe(0)
  })

  it("200s and returns a shaped moment row for a valid wallet", async () => {
    const res = await POST(req({ input: "0xabcdef0123456789" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.totalMoments).toBe(1)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].playerName).toBe("Josh Allen")
    expect(body.rows[0].editionKey).toBe("1:2")
  })
})

// --- FMV enrichment, tier/serial shaping, username resolution, empty wallet ---

describe("POST /api/allday-wallet-search — enrichment + shaping", () => {
  beforeEach(() => {
    h.state.tables = {}
    fclState.ownedIds = [123]
    fclState.meta = null
    fclState.throwOn = null
    gql.result = {}
    gql.throws = false
  })

  it("attaches FMV from editions -> fmv_snapshots (first snapshot wins)", async () => {
    h.state.tables = {
      editions: [{ id: "uuid-1", external_id: "1:2" }],
      fmv_snapshots: [
        { edition_id: "uuid-1", fmv_usd: "35.5", confidence: "HIGH" },
        { edition_id: "uuid-1", fmv_usd: "1", confidence: "LOW" }, // older, ignored
      ],
    }
    const body = await (await POST(req({ input: "0xaaaaaaaaaaaa0001" }))).json()
    expect(body.rows[0].fmv).toBe(35.5)
    expect(body.rows[0].marketConfidence).toBe("high")
  })

  it("leaves fmv unset when the edition resolves but has no snapshot", async () => {
    h.state.tables = { editions: [{ id: "uuid-1", external_id: "1:2" }], fmv_snapshots: [] }
    const body = await (await POST(req({ input: "0xaaaaaaaaaaaa0002" }))).json()
    expect(body.rows[0].fmv ?? null).toBeNull()
  })

  it("returns an empty shell for a wallet that owns nothing", async () => {
    fclState.ownedIds = []
    const res = await POST(req({ input: "0xaaaaaaaaaaaa0003" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.summary.totalMoments).toBe(0)
  })

  it("normalizes tier labels and flags a #1 serial", async () => {
    fclState.meta = {
      player: "Josh Allen", team: "BUF", setName: "Base Set", setID: "1", playID: "2",
      serial: "1", mint: "100", series: "S1", tier: "LEGENDARY",
    }
    const body = await (await POST(req({ input: "0xaaaaaaaaaaaa0004" }))).json()
    // tier is passed through raw on the row; formatTier() shapes display elsewhere
    expect(body.rows[0].tier).toBe("LEGENDARY")
    expect(body.rows[0].specialSerialTraits).toContain("#1 Serial")
  })

  it("flags the last serial when serial === mint", async () => {
    fclState.meta = {
      player: "Josh Allen", team: "BUF", setName: "Base Set", setID: "1", playID: "2",
      serial: "100", mint: "100", series: "S1", tier: "COMMON",
    }
    const body = await (await POST(req({ input: "0xaaaaaaaaaaaa0005" }))).json()
    expect(body.rows[0].specialSerialTraits).toContain("Last Serial")
  })

  it("carries an ALL_DAY premium tier through on the row", async () => {
    fclState.meta = {
      player: "Josh Allen", team: "BUF", setName: "Base Set", setID: "1", playID: "2",
      serial: "5", mint: "100", series: "S1", tier: "IN_SEASON_PREMIUM",
    }
    const body = await (await POST(req({ input: "0xaaaaaaaaaaaa0006" }))).json()
    expect(body.rows[0].tier).toBe("IN_SEASON_PREMIUM")
  })

  it("resolves an @username to a wallet via the AllDay GQL", async () => {
    gql.result = { getUserProfileByUsername: { publicInfo: { flowAddress: "abcdef0123456789", username: "josh" } } }
    const res = await POST(req({ input: "@josh" }))
    expect(res.status).toBe(200)
    expect((await res.json()).summary.totalMoments).toBe(1)
  })

  it("errors cleanly when the username cannot be resolved", async () => {
    gql.result = { getUserProfileByUsername: { publicInfo: { flowAddress: null } } }
    const res = await POST(req({ input: "@ghost-user-xyz" }))
    expect([400, 404, 500]).toContain(res.status)
  })
})
