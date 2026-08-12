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
    // The driver message must not be published — this route is anon-reachable,
    // so this used to answer a visitor with the database's own text. It is
    // LOGGED server-side instead, and the body carries a classified code.
    expect(body.error).not.toContain("db down")
    expect(body.code).toBeTruthy()
    expect(body.results[0].bestOffer).toBeNull()
  })

  // marketplace_offers leg — the DapperOffersV2 bid feed for the non-Top-Shot
  // Flow collections (AllDay/UFC/Golazos), keyed by nft_id = momentId.
  it("attaches a marketplace_offers bid as 'Dapper Offer' for a non-Top-Shot collection", async () => {
    fx.tables = { marketplace_offers: { data: [{ nft_id: "m1", offer_price: 40 }] } }
    const res = await POST(post({ momentIds: ["m1"], editionKeys: ["1:2"], collectionId: "c1" }))
    const body = await res.json()
    expect(body.results[0]).toMatchObject({
      momentId: "m1",
      bestOffer: 40,
      bestOfferSource: "Dapper Offer",
      bestOfferType: "serial",
    })
  })

  it("surfaces a marketplace bid when the caller sends only momentIds (no edition keys)", async () => {
    // Regression pin: a non-Top-Shot caller that omits editionKeys used to hit an
    // early return (empty distinctKeys) and get all-null, silently dropping its
    // live DapperOffersV2 standing bids. The marketplace_offers leg is keyed by
    // momentId, so it must still run.
    fx.tables = { marketplace_offers: { data: [{ nft_id: "m1", offer_price: 40 }] } }
    const res = await POST(post({ momentIds: ["m1"], collectionId: "c1" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results[0]).toMatchObject({
      momentId: "m1",
      editionKey: null,
      bestOffer: 40,
      bestOfferSource: "Dapper Offer",
      bestOfferType: "serial",
    })
  })

  it("prefers the higher of the edition offer and the marketplace bid", async () => {
    fx.tables = {
      edition_offers: { data: [{ external_id: "1:2", highest_offer: 50 }] },
      marketplace_offers: { data: [{ nft_id: "m1", offer_price: 40 }] },
    }
    const res = await POST(post({ momentIds: ["m1"], editionKeys: ["1:2"], collectionId: "c1" }))
    const body = await res.json()
    // 50 (edition) > 40 (marketplace bid) → edition wins.
    expect(body.results[0]).toMatchObject({ bestOffer: 50, bestOfferSource: "Top Shot Edition" })
  })

  it("does NOT consult marketplace_offers for Top Shot (its edition/serial sources are authoritative)", async () => {
    fx.tables = {
      edition_offers: { data: [{ external_id: "1:2", highest_offer: 25 }] },
      // A larger marketplace bid exists but must be ignored for Top Shot.
      marketplace_offers: { data: [{ nft_id: "m1", offer_price: 999 }] },
    }
    const res = await POST(
      post({ momentIds: ["m1"], editionKeys: ["1:2"], collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd" }),
    )
    const body = await res.json()
    expect(body.results[0]).toMatchObject({ bestOffer: 25, bestOfferSource: "Top Shot Edition" })
  })
})
