import { describe, it, expect } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/best-offers.
// One guard short-circuits before any DB client is created: no collectionId or
// no momentIds → { results: [] } (200). We pin that guard shape here (the DB
// path needs a real Supabase client, created only past the guard).
//
// NOTE: an empty editionKeys list is NOT an early return — the marketplace_offers
// leg is keyed by momentId, so it still runs and can surface a bid. That path is
// covered in api-best-offers-integration.test.ts (which mocks the client).

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

})
