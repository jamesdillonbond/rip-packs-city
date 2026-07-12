import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/pinnacle-sniper-feed.
// This route is a pure alias — it re-exports { GET } from ../pinnacle-sniper.
// No auth / no guards. We mock the shared computePinnacleSniperFeed seam and
// confirm the alias resolves to a working handler returning the feed JSON.

const feed: { value: any } = { value: { deals: [], count: 0 } }

vi.mock("@/lib/sniper/pinnacle", () => ({
  computePinnacleSniperFeed: async () => feed.value,
}))

import { GET } from "@/app/api/pinnacle-sniper-feed/route"

const req = (url: string) => ({ url }) as any

describe("GET /api/pinnacle-sniper-feed", () => {
  it("re-exports a GET function", () => {
    expect(typeof GET).toBe("function")
  })

  it("returns the computed feed as JSON (alias of pinnacle-sniper)", async () => {
    feed.value = { deals: [{ id: "x" }], count: 1 }
    const res = await GET(req("https://t/api/pinnacle-sniper-feed"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deals: [{ id: "x" }], count: 1 })
  })
})
