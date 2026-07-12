import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/cart/validate. No auth (browser-called).
// The guards run entirely before any network I/O to Flow REST: bad JSON → 400,
// empty listings → {results:{}} 200 (no fetch), >50 listings → 400. We assert
// those pre-fetch guards; the per-listing Flow REST path is not exercised (it
// would require mocking global fetch and is covered by behavior, not guards).

import { POST } from "@/app/api/cart/validate/route"
import { makeReq } from "./cron-req-helper"

const URL = "https://t/api/cart/validate"

describe("POST /api/cart/validate", () => {
  it("400s on invalid JSON body", async () => {
    const res = await POST(makeReq({ url: URL, badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid JSON body")
  })

  it("returns an empty results map for an empty listings array (no network)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const res = await POST(makeReq({ url: URL, body: { listings: [] } }))
    expect(res.status).toBe(200)
    expect((await res.json()).results).toEqual({})
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it("treats a missing listings field as empty → {results:{}}", async () => {
    const res = await POST(makeReq({ url: URL, body: {} }))
    expect(res.status).toBe(200)
    expect((await res.json()).results).toEqual({})
  })

  it("400s when more than 50 listings are submitted", async () => {
    const listings = Array.from({ length: 51 }, (_, i) => ({
      listingResourceID: String(i),
      storefrontAddress: "0xabc",
    }))
    const res = await POST(makeReq({ url: URL, body: { listings } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("max 50 listings")
  })
})
