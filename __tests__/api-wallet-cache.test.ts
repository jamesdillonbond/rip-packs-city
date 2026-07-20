import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/wallet-cache. GET requires ?wallet= → 400,
// degrades to { ok:false, moments:[] } on a read error, else returns the cache.
// POST is lenient (never a hard error): missing wallet/moments, an unresolved
// collection, or an empty-after-filter row set all short-circuit to written:0;
// a resolved collection drives the chunked upsert_wmc_batch RPC. The mock is
// state-driven so both the GET read and the collection-resolve single() + the
// RPC can be steered per test. resolveCollectionId caches by db-slug at module
// scope, so tests that need distinct resolve outcomes use distinct slugs.

const state: {
  getData: any
  getError: any
  collectionId: string | null
  rpcWritten: number
  rpcError: any
} = { getData: [], getError: null, collectionId: null, rpcWritten: 0, rpcError: null }

vi.mock("@/lib/supabase", () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    // wallet_moments_cache GET ends in .limit()
    limit: async () => ({ data: state.getData, error: state.getError }),
    // collections resolve ends in .single()
    single: async () => ({ data: state.collectionId ? { id: state.collectionId } : null }),
  }
  return {
    supabaseAdmin: {
      from: () => chain,
      rpc: async () => ({ data: state.rpcError ? null : { written: state.rpcWritten }, error: state.rpcError }),
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
  it("degrades to ok:false / empty moments on a read error (never 500)", async () => {
    state.getError = { message: "read down" }
    const res = await GET(getReq("https://t/api/wallet-cache?wallet=0xabc"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(false)
    expect(j.moments).toEqual([])
  })
})

describe("POST /api/wallet-cache", () => {
  it("short-circuits to written:0 without wallet/moments", async () => {
    const res = await POST(postReq({}))
    expect(res.status).toBe(200)
    expect((await res.json()).written).toBe(0)
  })

  it("short-circuits to written:0 with an empty moments array", async () => {
    const res = await POST(postReq({ wallet: "0xabc", moments: [] }))
    expect((await res.json()).written).toBe(0)
  })

  it("skips with unresolved_collection when the collection can't resolve", async () => {
    state.collectionId = null // single() returns no row
    const res = await POST(
      postReq({ wallet: "0xabc", collection: "coll-unresolved-a", moments: [{ momentId: "m1" }] }),
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.written).toBe(0)
    expect(j.skipped).toBe("unresolved_collection")
  })

  it("returns written:0 when every moment lacks a momentId (nothing to key)", async () => {
    state.collectionId = "cid-b"
    const res = await POST(
      postReq({ wallet: "0xabc", collection: "coll-resolved-b", moments: [{ editionKey: "1:2" }, { serial: 3 }] }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).written).toBe(0)
  })

  it("resolves the collection and writes via the chunked RPC", async () => {
    state.collectionId = "cid-c"
    state.rpcWritten = 2
    const res = await POST(
      postReq({
        wallet: "0xabc",
        collection: "coll-resolved-c",
        moments: [{ momentId: "m1", editionKey: "1:2", serial: 5 }, { momentId: "m2" }],
      }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).written).toBe(2)
  })

  it("tolerates an RPC error per chunk (logs, counts 0, still ok)", async () => {
    state.collectionId = "cid-d"
    state.rpcError = { message: "rpc boom" }
    const res = await POST(
      postReq({ wallet: "0xabc", collection: "coll-resolved-d", moments: [{ momentId: "m1" }] }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).written).toBe(0)
  })
})
