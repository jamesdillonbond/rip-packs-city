import { describe, it, expect, afterEach, vi } from "vitest"

// Route integration test for GET /api/panini/market-stats.
// No auth and no pre-DB guards — it's an OpenSea collection-stats proxy with an
// in-process 5-min cache. The only clean mock seam is global fetch. We pin the
// 502 error path (upstream non-ok, cold cache -> { error: "Failed to fetch
// market stats" }) plus the import-only signature check.

import { GET } from "@/app/api/panini/market-stats/route"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

// The route keeps a module-level cache, so isolate cache state per case by
// re-importing a fresh module instance after resetModules().
async function freshGET() {
  vi.resetModules()
  return (await import("@/app/api/panini/market-stats/route")).GET
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

describe("GET /api/panini/market-stats", () => {
  it("exports a GET function", () => {
    expect(typeof GET).toBe("function")
  })

  it("502s when OpenSea stats are unreachable and the cache is cold", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })))
    const g = await freshGET()
    const res = await g()
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe("Failed to fetch market stats")
  })

  it("maps the OpenSea `total` stats block on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      ok({ total: { floor_price: 0.42, total_volume: 1234, total_sales: 88, num_owners: 50, total_supply: 500 } })))
    const g = await freshGET()
    const res = await g()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      floor_price: 0.42, floor_price_symbol: "ETH", total_volume: 1234,
      total_sales: 88, num_owners: 50, total_supply: 500,
    })
    expect(typeof body.updated_at).toBe("string")
  })

  it("falls back to the top-level object when there is no `total` wrapper, nulling missing fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ floor_price: 0.1 }))) // no `total`, no volume/etc
    const g = await freshGET()
    const body = await (await g()).json()
    expect(body.floor_price).toBe(0.1)
    expect(body.total_volume).toBeNull()
    expect(body.num_owners).toBeNull()
  })

  it("serves fresh cache within the TTL without a second fetch", async () => {
    const fetchMock = vi.fn(async () => ok({ total: { floor_price: 0.5 } }))
    vi.stubGlobal("fetch", fetchMock)
    const g = await freshGET()
    await g()            // populates cache
    const res2 = await g() // within TTL -> cache hit, no fetch
    expect(res2.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await res2.json()).floor_price).toBe(0.5)
  })

  it("serves STALE cache (200) when a later refresh throws", async () => {
    let call = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++
      if (call === 1) return ok({ total: { floor_price: 0.7 } })
      throw new Error("network down")
    }))
    const g = await freshGET()
    await g() // populate
    // force the TTL to look expired by advancing time
    const realNow = Date.now
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 10 * 60 * 1000)
    const res = await g() // TTL expired -> refetch throws -> stale cache
    expect(res.status).toBe(200)
    expect((await res.json()).floor_price).toBe(0.7)
    vi.mocked(Date.now).mockRestore()
  })
})
