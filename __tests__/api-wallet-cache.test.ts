import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/wallet-cache. GET requires ?wallet= → 400,
// degrades to { ok:false, moments:[] } on a read error, else returns the cache.
// POST is retired (2026-10-09) and must never write. The mock is state-driven so
// the GET read and any (forbidden) RPC call can be observed per test.

const state: {
  getData: any
  getError: any
  collectionId: string | null
  rpcWritten: number
  rpcError: any
  rpcCalls: any[]
} = { getData: [], getError: null, collectionId: null, rpcWritten: 0, rpcError: null, rpcCalls: [] }

vi.mock("@/lib/supabase", () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    // wallet_moments_cache GET pages via .range(from, to) over the full dataset
    // (a first-page error is surfaced; later pages slice state.getData).
    range: async (from: number, to: number) => {
      if (state.getError) return { data: null, error: state.getError }
      const all = Array.isArray(state.getData) ? state.getData : []
      return { data: all.slice(from, to + 1), error: null }
    },
    // collections resolve ends in .single()
    single: async () => ({ data: state.collectionId ? { id: state.collectionId } : null }),
  }
  return {
    supabaseAdmin: {
      from: () => chain,
      rpc: async (_name: string, args: any) => {
        state.rpcCalls.push(args)
        return { data: state.rpcError ? null : { written: state.rpcWritten }, error: state.rpcError }
      },
    },
  }
})

import { GET, POST } from "@/app/api/wallet-cache/route"

const getReq = (u: string) => ({ nextUrl: new URL(u) }) as any
const postReq = (body: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.getData = []
  state.getError = null
  state.collectionId = null
  state.rpcWritten = 0
  state.rpcError = null
  state.rpcCalls = []
})

describe("GET /api/wallet-cache", () => {
  it("400s without a wallet", async () => {
    const res = await GET(getReq("https://t/api/wallet-cache"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })
  it("returns cached moments for a wallet", async () => {
    state.getData = [{ moment_id: "1" }]
    const res = await GET(getReq("https://t/api/wallet-cache?wallet=0xabc"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.moments).toHaveLength(1)
  })
  it("returns MORE than the 1,000-row PostgREST cap (pages via .range())", async () => {
    // The bug this guards: a bare .limit(10000) is clamped to 1,000, silently
    // truncating a whale wallet. 2,500 rows must all come back across 3 pages.
    state.getData = Array.from({ length: 2500 }, (_, i) => ({ moment_id: String(i) }))
    const res = await GET(getReq("https://t/api/wallet-cache?wallet=0xwhale"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.moments).toHaveLength(2500)
  })
  it("degrades to ok:false / empty moments on a read error (never 500)", async () => {
    state.getError = { message: "read down" }
    const res = await GET(getReq("https://t/api/wallet-cache?wallet=0xabc"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(false)
    expect(j.moments).toEqual([])
  })
})

// INVERTED 2026-10-09: POST used to upsert client-supplied holdings (wallet,
// moment, edition key, serial — all from the body) into ANY wallet's cache via
// the service role, behind only a session. It is retired: it never writes.
describe("POST /api/wallet-cache — retired, never writes", () => {
  it("a well-formed body that used to write is accepted with 200 and writes NOTHING", async () => {
    state.collectionId = "cid-c"
    state.rpcWritten = 2
    // The route no longer even reads the body; a stale client still sends one.
    void postReq({
      wallet: "0xvictim000000000",
      collection: "nba-top-shot",
      moments: [{ momentId: "m1", editionKey: "1:2", serial: 5 }, { momentId: "m2", editionKey: "3:4", serial: 1 }],
    })
    const res = await POST()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.written).toBe(0)
    expect(j.skipped).toBe("retired_server_side_writers_only")
    expect(state.rpcCalls).toEqual([])
  })

  it("an empty body is the same harmless no-op", async () => {
    const res = await POST()
    expect(res.status).toBe(200)
    expect((await res.json()).written).toBe(0)
    expect(state.rpcCalls).toEqual([])
  })
})
