import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for POST /api/best-offers driving the REAL body:
// edition-grain offer harvest (edition_offers -> badge_editions fallback),
// optional serial-grain offers (get_serial_offers), and the per-moment
// eligible-max merge that decides bestOffer / source / type. The Supabase seam
// is stubbed with makeSupabaseFixture keyed by table + rpc.

const fx = vi.hoisted(() => ({ tables: {} as Record<string, { data?: unknown; error?: unknown }> }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => makeSupabaseFixture(fx.tables),
}))

const { POST } = await import("@/app/api/best-offers/route")

function post(body: unknown) {
  return new NextRequest("https://t/api/best-offers", { method: "POST", body: JSON.stringify(body) })
}

beforeEach(() => {
  fx.tables = {}
})

describe("POST /api/best-offers — integration", () => {
  it("returns null offers when collectionId is missing", async () => {
    const res = await POST(post({ momentIds: ["m1"], editionKeys: ["1:2"] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual([
      { momentId: "m1", editionKey: "1:2", bestOffer: null, bestOfferSource: null, bestOfferType: null },
    ])
  })

  it("returns null offers when there are no distinct edition keys", async () => {
    const res = await POST(post({ momentIds: ["m1"], editionKeys: ["  "], collectionId: "c1" }))
    const body = await res.json()
    expect(body.results[0].bestOffer).toBeNull()
  })

  it("attaches the edition-grain offer as 'Top Shot Edition'", async () => {
    fx.tables = { edition_offers: { data: [{ external_id: "1:2", highest_offer: 25 }] } }
    const res = await POST(post({ momentIds: ["m1"], editionKeys: ["1:2"], collectionId: "c1" }))
    const body = await res.json()
    expect(body.results[0]).toMatchObject({
      momentId: "m1",
      editionKey: "1:2",
      bestOffer: 25,
      bestOfferSource: "Top Shot Edition",
      bestOfferType: "edition",
    })
  })

  it("prefers a higher serial-grain offer over the edition offer", async () => {
    fx.tables = {
      edition_offers: { data: [{ external_id: "1:2", highest_offer: 25 }] },
      "rpc:get_serial_offers": {
        data: [{ external_id: "1:2", serial_number: 7, offer_amount_usd: 90 }],
      },
    }
    const res = await POST(
      post({ momentIds: ["m1"], editionKeys: ["1:2"], serials: [7], collectionId: "c1" }),
    )
    const body = await res.json()
    expect(body.results[0]).toMatchObject({
      bestOffer: 90,
      bestOfferSource: "Top Shot Serial",
      bestOfferType: "serial",
    })
  })

  it("falls back to badge_editions when edition_offers has no row", async () => {
    fx.tables = {
      edition_offers: { data: [] },
      badge_editions: { data: [{ external_id: "1:2", highest_offer: 12 }] },
    }
    const res = await POST(post({ momentIds: ["m1"], editionKeys: ["1:2"], collectionId: "c1" }))
    const body = await res.json()
    expect(body.results[0].bestOffer).toBe(12)
    expect(body.results[0].bestOfferSource).toBe("Top Shot Edition")
  })

  it("500s with emptyResults when the offers query errors", async () => {
    fx.tables = { edition_offers: { error: { message: "db down" } } }
    const res = await POST(post({ momentIds: ["m1"], editionKeys: ["1:2"], collectionId: "c1" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("db down")
    expect(body.results[0].bestOffer).toBeNull()
  })
})
