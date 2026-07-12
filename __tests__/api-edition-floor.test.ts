import { describe, it, expect } from "vitest"

// Route integration test for /api/edition-floor (GET + POST). This route fans
// out to live Top Shot + Flowty HTTP endpoints, so the tested paths are the
// pre-fetch guards only:
//   - GET 400 without editionKey
//   - POST 400 on invalid JSON body
//   - POST empty editionKeys → { results: [] }
//   - GET with a colon-less editionKey → resolveEditionFloor early-returns a
//     null result WITHOUT any network call (setID/playID split guard), giving a
//     deterministic happy-ish path with no fetch mocking.
// No auth gate exists on this route; persist=1 (the only Supabase seam) is not
// exercised so the createClient path never runs.

import { GET, POST } from "@/app/api/edition-floor/route"

const getReq = (url: string) => ({ nextUrl: new URL(url) }) as any
function postReq(body: any, badJson = false): any {
  return { json: async () => { if (badJson) throw new Error("bad json"); return body } }
}

describe("GET /api/edition-floor", () => {
  it("400s without editionKey", async () => {
    const res = await GET(getReq("https://t/api/edition-floor"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("editionKey required")
  })

  it("returns an all-null result for a colon-less editionKey (no network)", async () => {
    const res = await GET(getReq("https://t/api/edition-floor?editionKey=malformed"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.editionKey).toBe("malformed")
    expect(body.crossMarketFloor).toBeNull()
    expect(body.topShotFloor).toBeNull()
  })
})

describe("POST /api/edition-floor", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(postReq(null, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid body")
  })

  it("returns an empty results array when no editionKeys are supplied", async () => {
    const res = await POST(postReq({ editionKeys: [] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [] })
  })
})
