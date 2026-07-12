import { describe, it, expect } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/best-offers.
// Early returns before any DB client is created: no collectionId or no momentIds
// → { results: [] } (200); momentIds present but no non-empty editionKeys →
// per-moment null-offer results (200). We pin those guard shapes (the DB path
// needs a real Supabase client, created only past the guards).

import { POST } from "@/app/api/best-offers/route"

function req(body: any): NextRequest {
  return new NextRequest("https://t/api/best-offers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/best-offers", () => {
  it("returns empty results with no collectionId / momentIds", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(200)
    expect((await res.json()).results).toEqual([])
  })

  it("returns per-moment null offers when no edition keys are supplied", async () => {
    const res = await POST(req({ collectionId: "col-1", momentIds: ["m1", "m2"], editionKeys: ["", ""] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(2)
    expect(body.results.every((r: any) => r.bestOffer === null)).toBe(true)
    expect(body.results[0].momentId).toBe("m1")
  })
})
