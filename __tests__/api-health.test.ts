import { describe, it, expect } from "vitest"

// Route integration test for /api/health — the lightweight liveness probe.
// No DB, no mocks: the handler takes no args and returns a static JSON body
// { ok: true, timestamp } at 200 with Cache-Control: no-store.

import { GET } from "@/app/api/health/route"

describe("GET /api/health", () => {
  it("returns ok:true at 200 with a no-store cache header", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    const body = await res.json()
    expect(body.ok).toBe(true)
    // timestamp is a valid ISO string
    expect(typeof body.timestamp).toBe("string")
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false)
  })
})
