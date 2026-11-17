import { describe, it, expect } from "vitest"
import {
  FMV_ALERT_LABEL,
  COLLECTION_URL_SLUG,
  editionHref,
} from "@/lib/alerts/edition-link"
import { getCollectionByUuid } from "@/lib/collection-slug"

describe("FMV_ALERT_LABEL", () => {
  it("renders threshold-aware labels per alert type", () => {
    expect(FMV_ALERT_LABEL.price_below(25)).toBe("Ask ≤ $25")
    expect(FMV_ALERT_LABEL.fmv_below(10)).toBe("FMV ≤ $10")
    expect(FMV_ALERT_LABEL.fmv_above(100)).toBe("FMV ≥ $100")
    expect(FMV_ALERT_LABEL.discount_above(30)).toBe("Ask ≥ 30% below FMV")
  })
  it("has exactly the four alert types", () => {
    expect(Object.keys(FMV_ALERT_LABEL).sort()).toEqual([
      "discount_above",
      "fmv_above",
      "fmv_below",
      "price_below",
    ])
  })
})

describe("editionHref", () => {
  it("maps each known collection UUID to its entity-page slug", () => {
    expect(editionHref({ collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", edition_key: "1:2" })).toBe(
      "/nba-top-shot/edition/1%3A2"
    )
    expect(editionHref({ collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070", edition_key: "abc" })).toBe(
      "/nfl-all-day/edition/abc"
    )
    expect(editionHref({ collection_id: "9b4824a8-736d-4a96-b450-8dcc0c46b023", edition_key: "x" })).toBe(
      "/ufc/edition/x" // canonical UFC slug, NOT the "ufc-strike" alias
    )
  })
  it("URL-encodes the edition key", () => {
    expect(editionHref({ collection_id: "06248cc4-b85f-47cd-af67-1855d14acd75", edition_key: "a b/c" })).toBe(
      "/laliga-golazos/edition/a%20b%2Fc"
    )
  })
  // INVERTED 2026-10-09 — this pinned an UNMAPPED collection falling back to
  // nba-top-shot: "View" on a Pinnacle (or any unmapped) alert opened the Top
  // Shot edition sharing the key. Absent still defaults; unmapped gets no link.
  it("gives NO link for an unmapped collection, never another collection's edition", () => {
    expect(editionHref({ collection_id: "unknown-uuid", edition_key: "k" })).toBeNull()
    expect(editionHref({ collection_id: "constructor", edition_key: "k" })).toBeNull()
  })
  it("an absent collection keeps the Top Shot default the route stores", () => {
    expect(editionHref({ collection_id: null, edition_key: "k" })).toBe("/nba-top-shot/edition/k")
  })
  it("Candy MLB alerts link to the shared edition page", () => {
    expect(editionHref({ collection_id: "209ade70-32c5-4470-bc7c-4793d660f713", edition_key: "e1" })).toBe("/candy-mlb/edition/e1")
  })
  it("Panini alerts link to the shared edition page (watch offered there since 2026-10-19)", () => {
    expect(editionHref({ collection_id: "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b", edition_key: "packcard-1_2_3_4" })).toBe("/panini-blockchain/edition/packcard-1_2_3_4")
  })
  // RE-PINNED 2026-10-26 (premise changed): the watch button is offered on Pinnacle pin pages now,
  // and a Pinnacle alert's key is a render_id whose page is /pinnacle/moment/<render_id>. It still
  // has no COLLECTION_URL_SLUG entry: /disney-pinnacle/edition/<key> only 308s to the pin page.
  it("a Pinnacle alert links its PIN page by render_id, not the shared edition route", () => {
    expect(editionHref({ collection_id: "7dd9dd11-e8b6-45c4-ac99-71331f959714", edition_key: "OEV1-PXIC-BUZZ-S3" })).toBe("/pinnacle/moment/OEV1-PXIC-BUZZ-S3")
    expect(editionHref({ collection_id: "7DD9DD11-E8B6-45C4-AC99-71331F959714", edition_key: "a b" })).toBe("/pinnacle/moment/a%20b")
    expect(COLLECTION_URL_SLUG["7dd9dd11-e8b6-45c4-ac99-71331f959714"]).toBeUndefined()
  })
  it("every slug matches the canonical registry (no duplicate-canonical drift)", () => {
    // Guards the exact bug this map carried: UFC mapped to the "ufc-strike" alias
    // instead of the canonical "ufc", so an alert link resolved to a duplicate of
    // the crawler-indexed /ufc/edition/... URL. Pin each UUID to its registry slug.
    for (const [uuid, slug] of Object.entries(COLLECTION_URL_SLUG)) {
      expect(getCollectionByUuid(uuid)?.urlSlug).toBe(slug)
    }
  })
})
