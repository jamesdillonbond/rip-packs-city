import { describe, it, expect, afterEach, vi } from "vitest"

// Route integration test for GET /api/panini/market-stats.
// No auth and no pre-DB guards — it's an OpenSea collection-stats proxy with an
// in-process 5-min cache. The only clean mock seam is global fetch. We pin the
// 502 error path (upstream non-ok, cold cache -> { error: "Failed to fetch
// market stats" }) plus the import-only signature check.

import { GET } from "@/app/api/panini/market-stats/route"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("GET /api/panini/market-stats", () => {
  it("exports a GET function", () => {
    expect(typeof GET).toBe("function")
  })

  it("502s when OpenSea stats are unreachable and the cache is cold", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })))
    const res = await GET()
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe("Failed to fetch market stats")
  })
})
