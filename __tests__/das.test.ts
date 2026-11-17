import { describe, it, expect, vi, beforeAll, afterEach } from "vitest"

// lib/chains/solana/das.ts — DAS (Solana Digital Asset Standard) read client.
// We test ONLY the pure request-payload builders (getAssetsByGroup /
// getAssetsByOwner / getAsset), which construct the JSON-RPC body sent through
// helius-proxy. `fetch` is stubbed to capture the outgoing request so no
// network is touched; the low-level dasCall network/error behavior is out of
// scope. Env must be present at import time (the module reads it top-level), so
// the module is imported dynamically after the env is set.

process.env.HELIUS_PROXY_URL = "https://helius.example/proxy"
process.env.HELIUS_PROXY_SECRET = "test-secret"

type Das = typeof import("@/lib/chains/solana/das")
let das: Das

beforeAll(async () => {
  das = await import("@/lib/chains/solana/das")
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Stub fetch, capture calls, return a valid DAS page envelope.
function stubFetch() {
  const calls: Array<{ url: unknown; init: any }> = []
  const fn = vi.fn(async (url: unknown, init: any) => {
    calls.push({ url, init })
    return {
      ok: true,
      json: async () => ({ result: { total: 0, limit: 1000, page: 1, items: [] } }),
    } as any
  })
  vi.stubGlobal("fetch", fn)
  return calls
}

describe("getAssetsByGroup payload", () => {
  it("builds the getAssetsByGroup JSON-RPC body with explicit page/limit", async () => {
    const calls = stubFetch()
    await das.getAssetsByGroup("COLL_ADDR", 2, 500)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://helius.example/proxy")
    const body = JSON.parse(calls[0].init.body)
    expect(body.jsonrpc).toBe("2.0")
    expect(body.id).toBe(1)
    expect(body.method).toBe("getAssetsByGroup")
    expect(body.params).toEqual({
      groupKey: "collection",
      groupValue: "COLL_ADDR",
      page: 2,
      limit: 500,
    })
  })

  it("defaults page=1, limit=1000 and sends proxy secret + json content-type", async () => {
    const calls = stubFetch()
    await das.getAssetsByGroup("COLL_ADDR")
    const { init } = calls[0]
    expect(init.method).toBe("POST")
    expect(init.headers["X-Proxy-Secret"]).toBe("test-secret")
    expect(init.headers["Content-Type"]).toBe("application/json")
    const body = JSON.parse(init.body)
    expect(body.params.page).toBe(1)
    expect(body.params.limit).toBe(1000)
  })
})

describe("getAssetsByOwner payload", () => {
  it("builds the getAssetsByOwner body keyed by ownerAddress", async () => {
    const calls = stubFetch()
    await das.getAssetsByOwner("0xowner", 3, 250)
    const body = JSON.parse(calls[0].init.body)
    expect(body.method).toBe("getAssetsByOwner")
    expect(body.params).toEqual({ ownerAddress: "0xowner", page: 3, limit: 250 })
  })

  it("defaults page=1, limit=1000", async () => {
    const calls = stubFetch()
    await das.getAssetsByOwner("0xowner")
    const body = JSON.parse(calls[0].init.body)
    expect(body.params).toEqual({ ownerAddress: "0xowner", page: 1, limit: 1000 })
  })
})

describe("getAsset payload", () => {
  it("builds the getAsset body keyed by id", async () => {
    const calls = stubFetch()
    await das.getAsset("MINT_PUBKEY")
    const body = JSON.parse(calls[0].init.body)
    expect(body.method).toBe("getAsset")
    expect(body.params).toEqual({ id: "MINT_PUBKEY" })
  })
})
