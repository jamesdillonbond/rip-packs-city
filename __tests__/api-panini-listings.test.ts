import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for GET /api/panini/listings.
// No auth and no pre-DB guards — it's an OpenSea REST proxy with an in-process
// cache. The only clean mock seam is global fetch. We pin the 502 error path
// (upstream non-ok, no warm cache -> { error: "Failed to fetch listings" }).
// A green happy path would require faking the full OpenSea listings + NFT +
// CoinGecko fetch sequence and would poison the module-level cache for other
// assertions, so we cover the error path plus the import-only signature check.

import { GET } from "@/app/api/panini/listings/route"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GET /api/panini/listings", () => {
  it("exports a GET function", () => {
    expect(typeof GET).toBe("function")
  })

  it("502s when OpenSea is unreachable and there is no warm cache", async () => {
    // NOTE: first-run cache is empty, so an upstream failure falls through to 502.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })))
    const res = await GET()
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe("Failed to fetch listings")
  })
})
