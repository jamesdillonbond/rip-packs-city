import { describe, expect, it } from "vitest"
import {
  GOLAZOS_COLLECTION_ID,
  parseStorefrontListings,
  planReconcile,
  type ListingRow,
  type StorefrontListing,
} from "@/lib/golazos/storefront-reconcile"

const NOW = 1_800_000_000
const SELLER = "0x709dac865ee203c5"
const OTHER = "0x176767b813ffe35e"
const EDITIONS = new Map([["89", "ed-uuid-89"], ["347", "ed-uuid-347"]])

function listing(p: Partial<StorefrontListing> & { listingId: string }): StorefrontListing {
  return {
    nftId: "1000",
    editionExternalId: "89",
    live: true,
    expiryEpoch: NOW + 86_400,
    salePrice: 12.5,
    vaultType: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
    ...p,
  }
}

function row(p: Partial<ListingRow> & { listing_resource_id: string }): ListingRow {
  return {
    source: "direct_v2",
    flow_id: "1000",
    edition_id: null,
    collection_id: GOLAZOS_COLLECTION_ID,
    seller_address: SELLER,
    price_usd: 10,
    currency: "DUC",
    custom_id: "c",
    listed_at: "2026-08-01T00:00:00.000Z",
    expiry_at: null,
    completed_at: null,
    completed_status: null,
    block_height: 123,
    tx_hash: "tx",
    event_index: 4,
    ...p,
  }
}

function plan(walked: Array<[string, StorefrontListing[]]>, existing: ListingRow[]) {
  return planReconcile({ walkedSellers: new Map(walked), existing, editionUuidByExternalId: EDITIONS, nowEpoch: NOW })
}

describe("planReconcile — Golazos storefront reconciliation", () => {
  it("inserts a live listing the indexer never saw as storefront_v2, with its edition resolved", () => {
    const p = plan([[SELLER, [listing({ listingId: "L1" })]]], [])
    expect(p.upserts).toHaveLength(1)
    expect(p.upserts[0]).toMatchObject({
      listing_resource_id: "L1",
      source: "storefront_v2",
      edition_id: "ed-uuid-89",
      price_usd: 12.5,
      currency: "DUC",
      completed_at: null,
    })
    expect(p.counts.inserted).toBe(1)
    expect(p.closes).toHaveLength(0)
  })

  it("updates an existing event-backed row in place: keeps its source and chain metadata, fills a missing edition", () => {
    const p = plan([[SELLER, [listing({ listingId: "L1" })]]], [row({ listing_resource_id: "L1" })])
    expect(p.upserts).toHaveLength(1)
    expect(p.upserts[0]).toMatchObject({
      source: "direct_v2",
      block_height: 123,
      tx_hash: "tx",
      event_index: 4,
      listed_at: "2026-08-01T00:00:00.000Z",
      edition_id: "ed-uuid-89",
      price_usd: 12.5,
    })
    expect(p.counts.updated).toBe(1)
    expect(p.counts.inserted).toBe(0)
  })

  it("never overwrites a known edition with null when the storefront's edition is not in the catalogue", () => {
    const p = plan(
      [[SELLER, [listing({ listingId: "L1", editionExternalId: "99999" })]]],
      [row({ listing_resource_id: "L1", edition_id: "ed-known" })],
    )
    expect(p.upserts[0].edition_id).toBe("ed-known")
  })

  it("closes an open row whose listing is a ghost, and never inserts a ghost", () => {
    const p = plan(
      [[SELLER, [listing({ listingId: "L1", live: false }), listing({ listingId: "L2", live: false })]]],
      [row({ listing_resource_id: "L1" })],
    )
    expect(p.upserts).toHaveLength(0)
    expect(p.closes).toEqual([{ listing_resource_id: "L1", source: "direct_v2", status: "ghosted" }])
  })

  it("closes an open row that a walked storefront no longer holds as vanished", () => {
    const p = plan([[SELLER, []]], [row({ listing_resource_id: "GONE" })])
    expect(p.closes).toEqual([{ listing_resource_id: "GONE", source: "direct_v2", status: "vanished" }])
  })

  it("leaves every row of a seller that was NOT walked untouched (a failed walk is not an empty storefront)", () => {
    const p = plan([[SELLER, []]], [row({ listing_resource_id: "X", seller_address: OTHER })])
    expect(p.closes).toHaveLength(0)
    expect(p.upserts).toHaveLength(0)
  })

  it("never closes V1 or Flowty-fork rows, which a V2 storefront walk cannot see", () => {
    const p = plan(
      [[SELLER, []]],
      [row({ listing_resource_id: "V1", source: "direct_v1" }), row({ listing_resource_id: "FF", source: "direct" })],
    )
    expect(p.closes).toHaveLength(0)
  })

  it("reopens a row this reconciler closed once the listing is live again, but never one closed by a sale event", () => {
    const p = plan(
      [[SELLER, [listing({ listingId: "G" }), listing({ listingId: "P" })]]],
      [
        row({ listing_resource_id: "G", completed_at: "2026-09-20T00:00:00Z", completed_status: "ghosted" }),
        row({ listing_resource_id: "P", completed_at: "2026-09-20T00:00:00Z", completed_status: "purchased" }),
      ],
    )
    expect(p.upserts.map((u) => u.listing_resource_id)).toEqual(["G"])
    expect(p.upserts[0]).toMatchObject({ completed_at: null, completed_status: null })
    expect(p.counts.reopened).toBe(1)
  })

  it("closes an open row whose on-chain listing has expired, and does not publish it", () => {
    const p = plan(
      [[SELLER, [listing({ listingId: "E", expiryEpoch: NOW - 1 })]]],
      [row({ listing_resource_id: "E" })],
    )
    expect(p.upserts).toHaveLength(0)
    expect(p.closes).toEqual([{ listing_resource_id: "E", source: "direct_v2", status: "expired" }])
  })

  it("publishes no USD price for a listing priced in FLOW", () => {
    const p = plan(
      [[SELLER, [listing({ listingId: "F", vaultType: "A.1654653399040a61.FlowToken.Vault" })]]],
      [],
    )
    expect(p.upserts[0]).toMatchObject({ currency: "FLOW", price_usd: null })
  })

  it("matches rows to a walked seller regardless of address case", () => {
    const p = plan([[SELLER, []]], [row({ listing_resource_id: "M", seller_address: SELLER.toUpperCase().replace("0X", "0x") })])
    expect(p.closes).toHaveLength(1)
  })

  it("matches a row whose id arrives as a JSON NUMBER (PostgREST bigint) to the storefront's STRING id", () => {
    // The first production run (2026-09-25) missed every match on exactly this:
    // 3,338 live listings inserted as duplicates, 514 open rows closed as vanished.
    const numericRow = row({ listing_resource_id: 216603793360707 as unknown as string })
    const p = plan(
      [[SELLER, [listing({ listingId: "216603793360707" })]]],
      [numericRow, row({ listing_resource_id: 15393165463266 as unknown as string })],
    )
    expect(p.counts).toMatchObject({ inserted: 0, updated: 1, vanished: 1 })
    expect(p.upserts[0].source).toBe("direct_v2")
    expect(String(p.closes[0].listing_resource_id)).toBe("15393165463266")
  })

  it("prefers the event-backed row when a listing exists under both sources", () => {
    const p = plan(
      [[SELLER, [listing({ listingId: "D" })]]],
      [row({ listing_resource_id: "D", source: "storefront_v2", block_height: null, tx_hash: null, event_index: null }), row({ listing_resource_id: "D" })],
    )
    expect(p.upserts).toHaveLength(1)
    expect(p.upserts[0].source).toBe("direct_v2")
  })
})

describe("parseStorefrontListings", () => {
  it("reads the script's string map, treating a missing editionId as unresolved", () => {
    const [a, b] = parseStorefrontListings([
      { listingId: "1", nftId: "2", expiry: "33239345661", salePrice: "8.00000000", vault: "V", live: "1", editionId: "347", serial: "769" },
      { listingId: "3", nftId: "4", expiry: "1", salePrice: "1.0", vault: "V", live: "0" },
    ])
    expect(a).toMatchObject({ listingId: "1", editionExternalId: "347", live: true, salePrice: 8 })
    expect(b).toMatchObject({ editionExternalId: null, live: false })
  })

  it("throws on a malformed result instead of reading it as an empty storefront", () => {
    expect(() => parseStorefrontListings(null)).toThrow()
    expect(() => parseStorefrontListings([{ nftId: "1" }])).toThrow()
  })
})
