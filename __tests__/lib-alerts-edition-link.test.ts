import { describe, it, expect } from "vitest"
import {
  FMV_ALERT_LABEL,
  COLLECTION_URL_SLUG,
  editionHref,
} from "@/lib/alerts/edition-link"

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
      "/ufc-strike/edition/x"
    )
  })
  it("URL-encodes the edition key", () => {
    expect(editionHref({ collection_id: "06248cc4-b85f-47cd-af67-1855d14acd75", edition_key: "a b/c" })).toBe(
      "/laliga-golazos/edition/a%20b%2Fc"
    )
  })
  it("falls back to nba-top-shot for an unmapped or null collection", () => {
    expect(editionHref({ collection_id: "unknown-uuid", edition_key: "k" })).toBe("/nba-top-shot/edition/k")
    expect(editionHref({ collection_id: null, edition_key: "k" })).toBe("/nba-top-shot/edition/k")
  })
  it("COLLECTION_URL_SLUG has no Pinnacle entry (watch button not offered there)", () => {
    expect(COLLECTION_URL_SLUG["7dd9dd11-e8b6-45c4-ac99-71331f959714"]).toBeUndefined()
  })
})
