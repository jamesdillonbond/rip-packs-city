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
      // `bestOfferAgeHours: null` is part of the shape, not an optional extra: a
      // consumer that reads it must be able to tell UNKNOWN from FRESH, and an absent
      // key cannot answer that.
      { momentId: "m1", editionKey: "1:2", bestOffer: null, bestOfferSource: null, bestOfferType: null, bestOfferAgeHours: null },
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

// ── The fresher SOURCE wins, and the age travels with the winning leg ───────
//
// 🚨 WHY (2026-08-29). This route read `edition_offers` first and consulted
// `badge_editions` only for keys the sweep had MISSED, on the premise — written into
// the route's own header — that the sweep is the fresher source. Measured: true for
// Top Shot (33.0 h median vs 111.7 h), **false for All Day**, which has a dedicated
// hourly `allday-badge-low-ask-refresh` while `offers-sweep` barely reaches it —
// `edition_offers` **168.5 h** median vs `badge_editions` **1.0 h**. Of 2,052 All Day
// keys present in BOTH, **1,925 (94%) had a badge row at least a day fresher and 137
// disagreed on the value**, so the grid showed a week-old bid while an hour-old source
// said something else.
//
// ⭐ The fix is a RULE, not a per-collection switch: prefer the row we confirmed most
// recently, so it adapts on its own if either feed's health flips again.
describe("POST /api/best-offers — freshness", () => {
  const HOUR = 3_600_000
  const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString()

  it("🚨 prefers the FRESHER table even when its bid is LOWER", () => {
    // A bid that was withdrawn must not be beaten by a stale memory of it. This is
    // the All Day condition in miniature.
    fx.tables = {
      edition_offers: { data: [{ external_id: "1:2", highest_offer: 99, updated_at: ago(168) }] },
      badge_editions: { data: [{ external_id: "1:2", highest_offer: 40, updated_at: ago(1) }] },
    }
    return POST(post({ momentIds: ["m1"], editionKeys: ["1:2"], collectionId: "c1" }))
      .then((r) => r.json())
      .then((body) => {
        expect(body.results[0].bestOffer, "the week-old higher bid won over an hour-old one").toBe(40)
        expect(body.results[0].bestOfferAgeHours).toBeLessThan(2)
      })
  })

  it("CONTROL — when edition_offers IS the fresher one it still wins", () => {
    // The Top Shot condition. The rule must not have simply inverted the preference.
    fx.tables = {
      edition_offers: { data: [{ external_id: "1:2", highest_offer: 40, updated_at: ago(1) }] },
      badge_editions: { data: [{ external_id: "1:2", highest_offer: 99, updated_at: ago(168) }] },
    }
    return POST(post({ momentIds: ["m1"], editionKeys: ["1:2"], collectionId: "c1" }))
      .then((r) => r.json())
      .then((body) => expect(body.results[0].bestOffer).toBe(40))
  })

  it("CONTROL — with neither row datable it falls back to the higher bid", () => {
    fx.tables = {
      edition_offers: { data: [{ external_id: "1:2", highest_offer: 25, updated_at: null }] },
      badge_editions: { data: [{ external_id: "1:2", highest_offer: 60, updated_at: null }] },
    }
    return POST(post({ momentIds: ["m1"], editionKeys: ["1:2"], collectionId: "c1" }))
      .then((r) => r.json())
      .then((body) => {
        expect(body.results[0].bestOffer).toBe(60)
        expect(body.results[0].bestOfferAgeHours, "an undatable bid was given an age").toBeNull()
      })
  })

  it("a KNOWN confirmation time beats an unknown one", () => {
    fx.tables = {
      edition_offers: { data: [{ external_id: "1:2", highest_offer: 99, updated_at: null }] },
      badge_editions: { data: [{ external_id: "1:2", highest_offer: 40, updated_at: ago(50) }] },
    }
    return POST(post({ momentIds: ["m1"], editionKeys: ["1:2"], collectionId: "c1" }))
      .then((r) => r.json())
      .then((body) => {
        expect(body.results[0].bestOffer).toBe(40)
        expect(body.results[0].bestOfferAgeHours).toBeGreaterThan(49)
      })
  })

  it("🚨 a SERIAL offer that wins carries NO age — get_serial_offers has no timestamp", () => {
    // The age must be reset by the leg that takes over, not left behind by the loser.
    // Reporting the edition row's age against a serial bid would date the wrong number.
    fx.tables = {
      edition_offers: { data: [{ external_id: "1:2", highest_offer: 25, updated_at: ago(40) }] },
      "rpc:get_serial_offers": {
        data: [{ external_id: "1:2", serial_number: 7, offer_amount_usd: 80 }],
      },
    }
    return POST(post({ momentIds: ["m1"], editionKeys: ["1:2"], serials: [7], collectionId: "c1" }))
      .then((r) => r.json())
      .then((body) => {
        expect(body.results[0]).toMatchObject({ bestOffer: 80, bestOfferSource: "Top Shot Serial" })
        expect(
          body.results[0].bestOfferAgeHours,
          "the losing edition leg's age was left attached to a serial bid",
        ).toBeNull()
      })
  })

  it("CONTROL — an edition-grain winner DOES carry its age", () => {
    // Without this the two assertions above would pass on a route that never dates
    // anything at all.
    fx.tables = {
      edition_offers: { data: [{ external_id: "1:2", highest_offer: 25, updated_at: ago(40) }] },
    }
    return POST(post({ momentIds: ["m1"], editionKeys: ["1:2"], collectionId: "c1" }))
      .then((r) => r.json())
      .then((body) => {
        expect(body.results[0].bestOfferAgeHours).toBeGreaterThan(39)
        expect(body.results[0].bestOfferAgeHours).toBeLessThan(41)
      })
  })
})
