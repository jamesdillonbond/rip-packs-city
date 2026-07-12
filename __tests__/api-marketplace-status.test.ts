import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/marketplace-status (GET). No auth. Thin
// bridge over getMarketplaceStatus(collection). Mocks @/lib/marketplace-status.
// Pins the missing-collection 400 and the happy passthrough.

const state: { status: any } = { status: { open: true } }

vi.mock("@/lib/marketplace-status", () => ({
  getMarketplaceStatus: async (c: string) => ({ collection: c, ...state.status }),
}))

import { GET } from "@/app/api/marketplace-status/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.status = { open: true }
})

describe("GET /api/marketplace-status", () => {
  it("400s without a collection param", async () => {
    const res = await GET(req("https://t/api/marketplace-status"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("collection param required")
  })

  it("returns the status payload for a collection", async () => {
    const res = await GET(req("https://t/api/marketplace-status?collection=nba_top_shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collection).toBe("nba_top_shot")
    expect(body.open).toBe(true)
  })
})
