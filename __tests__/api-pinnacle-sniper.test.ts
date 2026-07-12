import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/pinnacle-sniper.
// No auth / no pre-DB guards — a thin wrapper over computePinnacleSniperFeed
// (lib/sniper/pinnacle). We mock that seam and pin the 200 happy path: the
// handler forwards query params and returns the feed as JSON.

const feed: { value: any } = { value: { deals: [], count: 0 } }
const spy = vi.fn(async (_opts?: any) => feed.value)

vi.mock("@/lib/sniper/pinnacle", () => ({
  computePinnacleSniperFeed: (opts: any) => spy(opts),
}))

import { GET } from "@/app/api/pinnacle-sniper/route"

const req = (url: string) => ({ url }) as any

describe("GET /api/pinnacle-sniper", () => {
  it("exports a GET function", () => {
    expect(typeof GET).toBe("function")
  })

  it("returns the computed feed as JSON", async () => {
    feed.value = { deals: [{ id: "d1" }], count: 1 }
    const res = await GET(req("https://t/api/pinnacle-sniper?maxPrice=50&minDiscount=10"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deals: [{ id: "d1" }], count: 1 })
  })

  it("forwards query params into the feed options", async () => {
    spy.mockClear()
    feed.value = { deals: [] }
    await GET(req("https://t/api/pinnacle-sniper?tier=Gold&player=Mickey&sortBy=price&maxPrice=25&minDiscount=5"))
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        variantFilter: "Gold",
        playerFilter: "Mickey",
        sortBy: "price",
        maxPrice: 25,
        minDiscount: 5,
      })
    )
  })
})
