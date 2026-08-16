import { describe, it, expect, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { installFetchMock, jsonRoute, type InstalledFetchMock } from "./helpers/route-harness"

// Route-integration test driving the ACTUAL handler body, not just its guards.
//
// ⚠ THREE ASSERTIONS IN THIS FILE PINNED THE DEFECT AND WERE REPOINTED
// (2026-08-16). Recorded here so nobody "restores" them:
//
//   1. `flowtyFloor === 15` from a two-listing fixture, and
//   2. `crossMarketFloor === 9 / crossMarketSource === "flowty"`.
//      `fetchFlowtyFloor` took setID/playID and used NEITHER — it asked the
//      collection-wide endpoint for the 48 cheapest TopShot listings on Flowty
//      and returned the minimum as though it were THIS edition's floor. The
//      fixtures fed it two arbitrary prices and asserted it picked the smaller,
//      so the tests were green precisely BECAUSE they reproduced the bug: they
//      encoded "min of whatever came back" as the contract. The leg is now
//      unimplemented (see the route's comment for why it cannot be fixed here),
//      so Flowty is reported absent rather than guessed.
//
//   3. `reports null floors when a venue endpoint errors (best-effort, still 200)`.
//      A 502 from the marketplace was served to callers as a 200 whose body is
//      byte-identical to a genuinely unlisted edition — the failure-renders-as-
//      data class. "best-effort, still 200" reads as leniency; what it actually
//      bought was the concierge telling a collector "nothing may be listed right
//      now" about an edition it had never managed to look up. Now a 503.
//
// The handler resolves each edition through the Top Shot GQL seam and no
// Supabase, so the harness stubs exactly that.

import { GET, POST } from "@/app/api/edition-floor/route"

// Top Shot searchEditions response carrying one edition's lowestAsk + forSaleCount.
function tsFloor(lowestAsk: number | null, forSaleCount: number) {
  return {
    data: {
      searchEditions: {
        data: {
          searchSummary: {
            data: { data: [{ setID: "1", playID: "2", lowestAsk, forSaleCount, circulationCount: 100 }] },
          },
        },
      },
    },
  }
}

let harness: InstalledFetchMock | null = null
afterEach(() => {
  harness?.restore()
  harness = null
})

describe("GET /api/edition-floor — integration (real handler, stubbed venues)", () => {
  it("400s without an editionKey (no fetch made)", async () => {
    harness = installFetchMock([])
    const res = await GET(new NextRequest("https://t/api/edition-floor"))
    expect(res.status).toBe(400)
    expect(harness.calls).toHaveLength(0)
  })

  it("returns the Top Shot floor as the cross-market floor", async () => {
    harness = installFetchMock([jsonRoute("nbatopshot.com", tsFloor(12.5, 3))])
    const res = await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.topShotFloor).toBe(12.5)
    expect(body.topShotListingCount).toBe(3)
    expect(body.crossMarketFloor).toBe(12.5)
    expect(body.crossMarketSource).toBe("topshot")
    // Only the Top Shot venue is called now; Flowty is not contacted at all.
    expect(harness.calls).toHaveLength(1)
  })

  it("never reports a Flowty floor it cannot attribute to this edition", async () => {
    // The regression guard for defects 1+2 above. Top Shot says nothing is
    // listed; the answer must be "no floor", NOT some other edition's price.
    harness = installFetchMock([jsonRoute("nbatopshot.com", tsFloor(null, 0))])
    const res = await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true) // we DID reach the marketplace
    expect(body.topShotFloor).toBeNull()
    expect(body.flowtyFloor).toBeNull()
    expect(body.flowtyListingCount).toBe(0)
    expect(body.livetokenFmv).toBeNull()
    expect(body.crossMarketFloor).toBeNull()
    expect(body.crossMarketSource).toBeNull()
  })

  it("503s when the marketplace cannot be reached — an outage is not an empty order book", async () => {
    harness = installFetchMock([jsonRoute("nbatopshot.com", {}, { status: 502 })])
    const res = await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2"))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe("floor_unavailable")
    // Must not carry a floor field a careless caller could render as a price.
    expect(body.topShotFloor).toBeUndefined()
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("distinguishes an empty order book from an outage", async () => {
    // The pair that must never collapse: same null floor, different status.
    harness = installFetchMock([jsonRoute("nbatopshot.com", tsFloor(null, 0))])
    const empty = await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2"))
    harness.restore()

    harness = installFetchMock([jsonRoute("nbatopshot.com", {}, { status: 500 })])
    const outage = await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2"))

    expect(empty.status).toBe(200)
    expect(outage.status).toBe(503)
  })

  it("treats a GQL errors[] payload as an outage, not as an empty book", async () => {
    // HTTP 200 with a GraphQL error is the shape a blocked/misconfigured proxy
    // returns most often, so it must not read as "nothing is listed".
    harness = installFetchMock([
      jsonRoute("nbatopshot.com", { errors: [{ message: "not authorized" }] }),
    ])
    const res = await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2"))
    expect(res.status).toBe(503)
  })
})

describe("POST /api/edition-floor — integration (batch, non-persist)", () => {
  it("resolves each editionKey and returns a results array", async () => {
    harness = installFetchMock([jsonRoute("nbatopshot.com", tsFloor(5, 1))])
    const res = await POST(
      new NextRequest("https://t/api/edition-floor", {
        method: "POST",
        body: JSON.stringify({ editionKeys: ["1:2"] }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0].crossMarketFloor).toBe(5)
    // The batch path keeps per-row `ok` so a caller can tell which rows are
    // answers and which are failures, rather than failing the whole batch.
    expect(body.results[0].ok).toBe(true)
  })

  it("marks a failed row ok:false instead of reporting it as unlisted", async () => {
    harness = installFetchMock([jsonRoute("nbatopshot.com", {}, { status: 502 })])
    const res = await POST(
      new NextRequest("https://t/api/edition-floor", {
        method: "POST",
        body: JSON.stringify({ editionKeys: ["1:2"] }),
      }),
    )
    const body = await res.json()
    expect(body.results[0].ok).toBe(false)
    expect(body.results[0].crossMarketFloor).toBeNull()
  })

  it("returns an empty results array for an empty editionKeys list (no fetch)", async () => {
    harness = installFetchMock([])
    const res = await POST(
      new NextRequest("https://t/api/edition-floor", { method: "POST", body: JSON.stringify({ editionKeys: [] }) }),
    )
    expect((await res.json()).results).toEqual([])
    expect(harness.calls).toHaveLength(0)
  })
})
