import { describe, it, expect } from "vitest"
import {
  deriveSerialBadges,
  showPriceBand,
  momentCanonicalPath,
  buildHeroImageCandidates,
  buildMomentProductLd,
} from "@/lib/moment-detail-seo"

// These pin the inline SEO/display derivations lifted out of
// app/moment/[id]/page.tsx. They are SEO-visible surfaces: a wrong Product
// JSON-LD price gets INDEXED, a broken canonical splits ranking between two
// URLs, and the hero-image candidate list is the documented fix for the
// "~30% blank black hero on legacy Series 1-4 Top Shot moments" regression.

describe("deriveSerialBadges", () => {
  it("returns [] for an edition-level page (serial null)", () => {
    expect(deriveSerialBadges(null, 100, new Set())).toEqual([])
  })
  it("adds #1 Serial for serial 1", () => {
    expect(deriveSerialBadges(1, 100, new Set())).toEqual(["#1 Serial"])
  })
  it("adds Perfect Serial when serial equals mint", () => {
    expect(deriveSerialBadges(100, 100, new Set())).toEqual(["Perfect Serial"])
  })
  it("adds both when serial 1 of 1", () => {
    expect(deriveSerialBadges(1, 1, new Set())).toEqual(["#1 Serial", "Perfect Serial"])
  })
  it("does NOT double up a label already present from the sweep", () => {
    expect(deriveSerialBadges(1, 100, new Set(["#1 Serial"]))).toEqual([])
    expect(deriveSerialBadges(100, 100, new Set(["Perfect Serial"]))).toEqual([])
  })
  it("never marks Perfect Serial when mint is 0 (missing circulation)", () => {
    // serial===mint===0 would falsely fire without the mint>0 guard
    expect(deriveSerialBadges(0, 0, new Set())).toEqual([])
  })
  it("returns nothing for a mid-run serial", () => {
    expect(deriveSerialBadges(37, 100, new Set())).toEqual([])
  })
})

describe("showPriceBand", () => {
  const band = { low: 10, high: 25 }
  it("shows for LOW confidence with >=10 sales and a valid band", () => {
    expect(showPriceBand({ confidence: "LOW", sales_count_30d: 12 }, band)).toBe(true)
  })
  it("shows for MEDIUM confidence", () => {
    expect(showPriceBand({ confidence: "MEDIUM", sales_count_30d: 10 }, band)).toBe(true)
  })
  it("hides for HIGH confidence (only LOW/MEDIUM get the band)", () => {
    expect(showPriceBand({ confidence: "HIGH", sales_count_30d: 99 }, band)).toBe(false)
  })
  it("hides below the 10-sale floor", () => {
    expect(showPriceBand({ confidence: "LOW", sales_count_30d: 9 }, band)).toBe(false)
  })
  it("hides a degenerate band (high == low)", () => {
    expect(showPriceBand({ confidence: "LOW", sales_count_30d: 12 }, { low: 10, high: 10 })).toBe(false)
  })
  it("hides when an end is missing", () => {
    expect(showPriceBand({ confidence: "LOW", sales_count_30d: 12 }, { low: 10, high: null })).toBe(false)
    expect(showPriceBand({ confidence: "LOW", sales_count_30d: 12 }, null)).toBe(false)
  })
  it("hides when fmv is missing", () => {
    expect(showPriceBand(null, band)).toBe(false)
    expect(showPriceBand(undefined, band)).toBe(false)
  })
  it("defaults a missing sales count to 0 (hidden)", () => {
    expect(showPriceBand({ confidence: "LOW" }, band)).toBe(false)
  })
})

describe("momentCanonicalPath", () => {
  it("points at the external_id edition route for standard collections", () => {
    expect(
      momentCanonicalPath({
        collectionSlug: "nba_top_shot",
        editionId: "uuid-1",
        externalId: "12:34",
        momentUrlId: "m-99",
      }),
    ).toBe("/nba-top-shot/edition/12%3A34")
  })
  it("uses the edition uuid for Pinnacle (not external_id)", () => {
    expect(
      momentCanonicalPath({
        collectionSlug: "disney_pinnacle",
        editionId: "pe-uuid",
        externalId: "legacy-key",
        momentUrlId: "m-1",
      }),
    ).toBe("/disney-pinnacle/edition/pe-uuid")
  })
  it("falls back to editionId when external_id is missing", () => {
    expect(
      momentCanonicalPath({
        collectionSlug: "nfl_all_day",
        editionId: "uuid-9",
        externalId: null,
        momentUrlId: "m-2",
      }),
    ).toBe("/nfl-all-day/edition/uuid-9")
  })
  it("self-canonicals to /moment/<id> when the slug is unresolvable", () => {
    expect(
      momentCanonicalPath({
        collectionSlug: "not_a_collection",
        editionId: "uuid",
        externalId: "x",
        momentUrlId: "m 3/4",
      }),
    ).toBe("/moment/m%203%2F4")
  })
  it("self-canonicals when collection slug is null", () => {
    expect(
      momentCanonicalPath({
        collectionSlug: null,
        editionId: "uuid",
        externalId: "x",
        momentUrlId: "m-4",
      }),
    ).toBe("/moment/m-4")
  })
})

describe("buildHeroImageCandidates", () => {
  it("prefers the per-moment media URL for Top Shot with a numeric id", () => {
    const out = buildHeroImageCandidates({
      collectionSlug: "nba_top_shot",
      marketplaceNftId: "123456",
      thumbnailUrl: "https://cdn.example/thumb.png",
    })
    expect(out[0]).toBe("https://assets.nbatopshot.com/media/123456/image?width=1080")
    expect(out[1]).toBe("https://cdn.example/thumb.png")
  })
  it("accepts the hyphenated Top Shot slug too", () => {
    const out = buildHeroImageCandidates({
      collectionSlug: "nba-top-shot",
      marketplaceNftId: "7",
      thumbnailUrl: null,
    })
    expect(out).toEqual(["https://assets.nbatopshot.com/media/7/image?width=1080"])
  })
  it("does NOT synthesize a media URL for a non-numeric id", () => {
    const out = buildHeroImageCandidates({
      collectionSlug: "nba_top_shot",
      marketplaceNftId: "abc",
      thumbnailUrl: "https://cdn.example/thumb.png",
    })
    expect(out).toEqual(["https://cdn.example/thumb.png"])
  })
  it("keeps only the stored thumbnail for non-Top-Shot collections", () => {
    const out = buildHeroImageCandidates({
      collectionSlug: "nfl_all_day",
      marketplaceNftId: "999",
      thumbnailUrl: "https://cdn.example/nfl.png",
    })
    expect(out).toEqual(["https://cdn.example/nfl.png"])
  })
  it("routes an ipfs.io gateway thumbnail through the same-origin proxy", () => {
    const out = buildHeroImageCandidates({
      collectionSlug: "ufc_strike",
      marketplaceNftId: null,
      thumbnailUrl: "https://ipfs.io/ipfs/QmHash/media.png",
    })
    // proxied form (see lib/ipfs-media): /api/public/ipfs-media/<captured>
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("/api/public/ipfs-media/")
  })
  it("returns [] when there is no candidate at all", () => {
    expect(
      buildHeroImageCandidates({ collectionSlug: "nfl_all_day", marketplaceNftId: null, thumbnailUrl: null }),
    ).toEqual([])
  })
})

describe("buildMomentProductLd", () => {
  const base = {
    subject: "LeBron James Dunk",
    serial: 5,
    mint: 100,
    setName: "Base Set",
    collectionDisplay: "NBA Top Shot",
    thumbnailUrl: "https://cdn.example/x.png",
    sku: "moment-1",
    fmvConfidence: "HIGH",
    fmvUsd: 42.5,
    floorPriceUsd: 40,
    topShotAsk: null,
    isListed: false,
    listPrice: null,
  }
  it("builds a full Product with an Offer at the FMV price", () => {
    const ld = buildMomentProductLd(base) as any
    expect(ld["@type"]).toBe("Product")
    expect(ld.name).toBe("LeBron James Dunk #5/100 · Base Set")
    expect(ld.description).toBe("LeBron James Dunk Base Set on NBA Top Shot")
    expect(ld.sku).toBe("moment-1")
    expect(ld.offers.price).toBe("42.50")
    expect(ld.offers.availability).toBe("https://schema.org/OutOfStock")
  })
  it("OMITS the Offer entirely when FMV is STALE (never index a wrong price)", () => {
    const ld = buildMomentProductLd({ ...base, fmvConfidence: "STALE" }) as any
    expect(ld.offers).toBeUndefined()
  })
  it("falls back to floor price when fmv_usd is null", () => {
    const ld = buildMomentProductLd({ ...base, fmvUsd: null }) as any
    expect(ld.offers.price).toBe("40.00")
  })
  it("omits the Offer when there is no price at all", () => {
    const ld = buildMomentProductLd({ ...base, fmvUsd: null, floorPriceUsd: null }) as any
    expect(ld.offers).toBeUndefined()
  })
  it("marks InStock when the serial has a live list price", () => {
    const ld = buildMomentProductLd({ ...base, isListed: true, listPrice: 50 }) as any
    expect(ld.offers.availability).toBe("https://schema.org/InStock")
  })
  it("marks InStock from an edition-level top_shot_ask", () => {
    const ld = buildMomentProductLd({ ...base, topShotAsk: 55 }) as any
    expect(ld.offers.availability).toBe("https://schema.org/InStock")
  })
  it("does not leave a trailing separator when set_name is null", () => {
    const ld = buildMomentProductLd({ ...base, setName: null }) as any
    expect(ld.name).toBe("LeBron James Dunk #5/100")
    expect(ld.description).toBe("LeBron James Dunk on NBA Top Shot")
  })
  it("omits the serial suffix for an edition-level page (serial null)", () => {
    const ld = buildMomentProductLd({ ...base, serial: null }) as any
    expect(ld.name).toBe("LeBron James Dunk · Base Set")
  })
})
