import { describe, it, expect, afterEach, vi } from "vitest"

// Route integration test for POST /api/cart/validate. No auth (browser-called).
// Covers the pre-fetch guards (bad JSON → 400, empty → {results:{}}, >50 → 400)
// AND the per-listing Flow REST path: the parseCadence decoder (Struct/Bool/
// Optional/UFix64/Address), the exists/price/seller extraction, priceChanged +
// sniped detection, and the two error results (non-ok HTTP / thrown fetch).

import { POST } from "@/app/api/cart/validate/route"
import { makeReq } from "./cron-req-helper"

const URL = "https://t/api/cart/validate"

// Flow REST /scripts returns the result as a JSON string wrapping a base64 blob
// of the JSON-Cadence value.
function flowBody(cadence: unknown): string {
  return JSON.stringify(btoa(JSON.stringify(cadence)))
}
function listingStatus(exists: boolean, price: number | null, seller: string | null) {
  return {
    type: "Struct",
    value: {
      id: "s.ListingStatus",
      fields: [
        { name: "exists", value: { type: "Bool", value: exists } },
        { name: "currentPrice", value: { type: "Optional", value: price == null ? null : { type: "UFix64", value: String(price) } } },
        { name: "sellerAddress", value: { type: "Optional", value: seller == null ? null : { type: "Address", value: seller } } },
      ],
    },
  }
}
function stubFetch(body: string, ok = true, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, status, text: async () => body })) as any)
}

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

describe("POST /api/cart/validate — per-listing Flow validation", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("decodes a live listing (exists, price, seller) with no price change", async () => {
    stubFetch(flowBody(listingStatus(true, 12.5, "0xseller00000001")))
    const res = await POST(makeReq({ url: URL, body: { listings: [{ listingResourceID: "L1", storefrontAddress: "0xabc0000000000001", expectedPrice: 12.5 }] } }))
    expect(res.status).toBe(200)
    const r = (await res.json()).results.L1
    expect(r).toMatchObject({ exists: true, currentPrice: 12.5, sellerAddress: "0xseller00000001", sniped: false, priceChanged: false })
  })

  it("flags priceChanged when the on-chain price differs from expected", async () => {
    stubFetch(flowBody(listingStatus(true, 20, "0xseller00000001")))
    const res = await POST(makeReq({ url: URL, body: { listings: [{ listingResourceID: "L1", storefrontAddress: "0xabc0000000000001", expectedPrice: 12.5 }] } }))
    const r = (await res.json()).results.L1
    expect(r.priceChanged).toBe(true)
    expect(r.currentPrice).toBe(20)
  })

  it("flags sniped when the listing no longer exists", async () => {
    stubFetch(flowBody(listingStatus(false, null, null)))
    const res = await POST(makeReq({ url: URL, body: { listings: [{ listingResourceID: "L1", storefrontAddress: "0xabc0000000000001" }] } }))
    const r = (await res.json()).results.L1
    expect(r.exists).toBe(false)
    expect(r.sniped).toBe(true)
    expect(r.currentPrice).toBeNull()
  })

  it("returns an error result on a non-ok Flow response", async () => {
    stubFetch("upstream fail", false, 500)
    const res = await POST(makeReq({ url: URL, body: { listings: [{ listingResourceID: "L1", storefrontAddress: "0xabc0000000000001" }] } }))
    const r = (await res.json()).results.L1
    expect(r.exists).toBe(false)
    expect(r.error).toMatch(/flow 500/)
  })

  it("returns an error result when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down") }) as any)
    const res = await POST(makeReq({ url: URL, body: { listings: [{ listingResourceID: "L1", storefrontAddress: "0xabc0000000000001" }] } }))
    const r = (await res.json()).results.L1
    expect(r.exists).toBe(false)
    expect(r.error).toMatch(/network down/)
  })
})
