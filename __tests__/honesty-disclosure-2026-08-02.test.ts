import { describe, it, expect } from "vitest"
import {
  isMarketClosed,
  closedMarket,
  formatClosedOn,
  closedPriceAsOf,
  CLOSED_MARKETS,
} from "@/lib/market-closed"
import {
  derivePackAvailability,
  packEvBasis,
} from "@/lib/pack-availability"
import {
  isSerialisedEditionType,
  SERIALISED_PINNACLE_EDITION_TYPES,
  KNOWN_UNSERIALISED_PINNACLE_EDITION_TYPES,
} from "@/lib/pinnacle/serialisation"
import { editionJsonLd, editionPageMetadata } from "@/lib/seo"

// `Metadata.title` is `string | { absolute } | { default, template }`.
// collectionLayoutMetadata and the four entity builders returned bare strings
// until 2026-08-23 and now return the `absolute` form — deliberately, because
// restoring the collection subtree's `%s | Rip Packs City` template (R31) would
// otherwise have double-suffixed every one of them. These assertions pin the
// TITLE TEXT, which is unchanged; only its wrapper moved, so they are updated
// rather than deleted. `titleText` accepts both, so the helpers that still
// return a plain string (pageMetadata) are asserted by the same expression.
const titleText = (t: unknown): string =>
  t !== null && typeof t === "object" && "absolute" in (t as Record<string, unknown>)
    ? String((t as { absolute: unknown }).absolute)
    : String(t)


// ---------------------------------------------------------------------------
// lib/market-closed — UFC Strike's Flow market closed 2026-05-13 (measured live:
// ZERO sales in 30 days by collection_id, by collection text, and in
// unmapped_sales; last sale 2026-05-13).
// ---------------------------------------------------------------------------
describe("market-closed registry", () => {
  it("marks UFC closed under BOTH its canonical slug and its accepted alias", () => {
    // getCollectionByUrlSlug resolves "ufc-strike", so those URLs render real
    // pages. If the alias were missing the disclosure would silently not apply
    // to every /ufc-strike/* page.
    expect(isMarketClosed("ufc")).toBe(true)
    expect(isMarketClosed("ufc-strike")).toBe(true)
    expect(closedMarket("ufc-strike")).toEqual(closedMarket("ufc"))
  })

  it("leaves every live collection alone", () => {
    for (const slug of ["nba-top-shot", "nfl-all-day", "laliga-golazos", "disney-pinnacle"]) {
      expect(isMarketClosed(slug)).toBe(false)
      expect(closedMarket(slug)).toBeNull()
      expect(closedPriceAsOf(slug)).toBeNull()
    }
  })

  it("is null-safe on absent/empty slugs", () => {
    expect(isMarketClosed(null)).toBe(false)
    expect(isMarketClosed(undefined)).toBe(false)
    expect(isMarketClosed("")).toBe(false)
    expect(closedMarket(null)).toBeNull()
  })

  it("formats the closure date deterministically from ISO parts", () => {
    // Built from the string, not Date parsing, so a server render and a client
    // hydration cannot disagree and no timezone can shift the day.
    expect(formatClosedOn("2026-05-13")).toBe("13 May 2026")
    expect(formatClosedOn("2026-01-01")).toBe("1 January 2026")
    expect(formatClosedOn("2026-12-31")).toBe("31 December 2026")
    expect(closedPriceAsOf("ufc")).toBe("as of 13 May 2026")
  })

  it("returns the raw input for a malformed date rather than inventing one", () => {
    expect(formatClosedOn("not-a-date")).toBe("not-a-date")
    expect(formatClosedOn("2026-13-01")).toBe("2026-13-01")
  })

  it("every registered closure carries a date, a venue and a note", () => {
    for (const [slug, cm] of Object.entries(CLOSED_MARKETS)) {
      expect(cm.closedOn, slug).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(cm.venue.length, slug).toBeGreaterThan(0)
      expect(cm.note.length, slug).toBeGreaterThan(40)
    }
  })
})

// ---------------------------------------------------------------------------
// lib/seo — the widest-blast-radius surface. Every UFC edition page is in the
// sitemap, so a schema.org Offer here is a price published straight to Google.
// ---------------------------------------------------------------------------
describe("seo: closed markets publish no schema.org Offer", () => {
  const detail = {
    route_slug: "some-ufc-edition",
    external_id: "some-ufc-edition",
    player_name: "A Fighter",
    set_name: "A Set",
    tier: "FANDOM",
    fmv: { fmv_usd: 123.45, confidence: "MEDIUM" },
  }

  function offerOf(ld: unknown): Record<string, unknown> | undefined {
    const graph = (ld as { "@graph": Array<Record<string, unknown>> })["@graph"]
    return graph[0]?.offers as Record<string, unknown> | undefined
  }

  it("emits an Offer on a LIVE market (control)", () => {
    expect(offerOf(editionJsonLd(detail, "nba-top-shot"))).toMatchObject({
      "@type": "Offer",
      price: 123.45,
      priceCurrency: "USD",
    })
  })

  it("emits NO Offer for UFC even on a fresh, MEDIUM-confidence FMV", () => {
    // This is the exact shape the confidence guard cannot catch: when a market
    // closes the FMV pipeline keeps re-stamping computed_at, so a dead price
    // carries MEDIUM confidence and a current timestamp. Measured 2026-08-02:
    // 15 UFC editions re-stamped that day off sales 470+ days old.
    expect(offerOf(editionJsonLd(detail, "ufc"))).toBeUndefined()
    expect(offerOf(editionJsonLd(detail, "ufc-strike"))).toBeUndefined()
  })

  it("emits NO Offer for UFC from a residual low ask either", () => {
    // A leftover ask on a shut marketplace is not executable, so it is not a
    // valid price source. Control: the same ask DOES publish on a live market.
    const noFmv = { ...detail, fmv: null }
    expect(offerOf(editionJsonLd(noFmv, "ufc", 42))).toBeUndefined()
    expect(offerOf(editionJsonLd(noFmv, "nba-top-shot", 42))).toMatchObject({ price: 42 })
  })

  it("still renders the Product itself, so the page is not de-indexed", () => {
    // Suppressing the price must not suppress the page.
    const graph = (editionJsonLd(detail, "ufc") as { "@graph": Array<Record<string, unknown>> })["@graph"]
    expect(graph[0]["@type"]).toBe("Product")
    expect(String(graph[0].description)).toContain("closed")
  })
})

describe("seo: closed markets do not title a dead price as a current value", () => {
  const payload = {
    route_slug: "x",
    player_name: "A Fighter",
    set_name: "A Set",
    fmv: { fmv_usd: 200, confidence: "MEDIUM" },
  }

  it("live market keeps the plain 'Value $X' title", () => {
    const m = editionPageMetadata(payload, "nba-top-shot")
    expect(titleText(m.title)).toContain("Value $200")
    expect(titleText(m.title)).not.toContain("market closed")
  })

  it("closed market says LAST value and names the closure", () => {
    const m = editionPageMetadata(payload, "ufc")
    expect(titleText(m.title)).toContain("Last Value")
    expect(titleText(m.title)).toContain("market closed")
    expect(String(m.description)).toContain("13 May 2026")
    // The description must not assert a present-tense worth.
    expect(String(m.description)).not.toContain("is worth")
  })
})

// ---------------------------------------------------------------------------
// lib/pack-availability
// ---------------------------------------------------------------------------
describe("pack availability", () => {
  it("classifies the three states", () => {
    expect(derivePackAvailability({ primary_available: true, secondary_available: false }).status).toBe("primary")
    expect(derivePackAvailability({ primary_available: false, secondary_available: true }).status).toBe("secondary")
    expect(derivePackAvailability({ primary_available: false, secondary_available: false }).status).toBe("retired")
  })

  it("primary wins when both legs are live", () => {
    expect(derivePackAvailability({ primary_available: true, secondary_available: true }).status).toBe("primary")
  })

  // 2026-08-04. Unmeasured availability still FAILS CLOSED -- that safety
  // property is unchanged and asserted below -- but it no longer CLAIMS we
  // checked. Measured live the same day: the pack_ev_latest cross-tab has no
  // (false,false) cell at all, so every one of the 3,883 "Retired" badges we
  // rendered sat on a row where availability was never measured.
  it("reports unmeasured availability as unknown, NOT as retired", () => {
    expect(derivePackAvailability({}).status).toBe("unknown")
    expect(derivePackAvailability({ primary_available: null, secondary_available: null }).status).toBe("unknown")
    // one leg measured, the other not -> still unknown; we cannot conclude
    expect(derivePackAvailability({ primary_available: false }).status).toBe("unknown")
    expect(derivePackAvailability({ secondary_available: false }).status).toBe("unknown")
  })

  it("still fails CLOSED on unknown — never a buy signal", () => {
    expect(derivePackAvailability({}).historical).toBe(true)
    expect(derivePackAvailability({ primary_available: null, secondary_available: null }).historical).toBe(true)
  })

  it("unknown copy does not assert a check we never ran", () => {
    const unknown = derivePackAvailability({})
    // The retired copy claims "is not on sale and has no live secondary
    // listing". Rendering that on an unmeasured row is the defect.
    expect(unknown.note).not.toMatch(/is not on sale/i)
    expect(unknown.label).not.toMatch(/retired/i)
    expect(unknown.note).toMatch(/no record/i)
  })

  it("reserves 'retired' for the case we actually measured as not buyable", () => {
    const retired = derivePackAvailability({ primary_available: false, secondary_available: false })
    expect(retired.status).toBe("retired")
    expect(retired.historical).toBe(true)
  })

  it("only the buyable states are flagged non-historical", () => {
    expect(derivePackAvailability({ primary_available: true }).historical).toBe(false)
    expect(derivePackAvailability({ secondary_available: true }).historical).toBe(false)
  })
})

describe("pack EV basis disclosure", () => {
  it("Top Shot is the remaining pool", () => {
    // compute_pack_ev_per_edition_weighted hard-codes v_use_original := false for TS.
    expect(packEvBasis("nba-top-shot")?.basis).toBe("remaining")
  })

  it("All Day and Golazos are original supply", () => {
    // Measured 2026-08-02: 89,783/89,783 AllDay and 1,957/1,957 Golazos pool rows
    // still sit at orig_drop_weight, so the function takes the original basis.
    expect(packEvBasis("nfl-all-day")?.basis).toBe("original")
    expect(packEvBasis("laliga-golazos")?.basis).toBe("original")
  })

  it("the original-supply note warns that it overstates a drained pack", () => {
    expect(packEvBasis("nfl-all-day")!.note.toLowerCase()).toContain("overstates")
  })

  it("Pinnacle gets NO basis label, because neither basis is true for it", () => {
    // Pinnacle has zero pack_drop_pool rows; its EV comes from the render-keyed
    // pipeline. Asserting either basis would be a fresh false statement.
    expect(packEvBasis("disney-pinnacle")).toBeNull()
    expect(packEvBasis("ufc")).toBeNull()
    expect(packEvBasis(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// lib/pinnacle/serialisation
// ---------------------------------------------------------------------------
describe("pinnacle serialisation", () => {
  it("recognises every serialised edition type", () => {
    for (const t of ["Limited Edition", "Limited Event Edition", "Legendary Edition", "Genesis Edition"]) {
      expect(isSerialisedEditionType(t), t).toBe(true)
    }
  })

  it("recognises every never-serialised edition type", () => {
    for (const t of ["Open Edition", "Open Event Edition", "Starter Edition"]) {
      expect(isSerialisedEditionType(t), t).toBe(false)
    }
  })

  it("returns null — 'cannot say' — for unknown or absent types", () => {
    // A new upstream edition type must NOT be labelled unserialised; that would
    // be a fresh false claim, which is what this module exists to prevent.
    expect(isSerialisedEditionType("Mythic Edition")).toBeNull()
    expect(isSerialisedEditionType(null)).toBeNull()
    expect(isSerialisedEditionType(undefined)).toBeNull()
    expect(isSerialisedEditionType("")).toBeNull()
    expect(isSerialisedEditionType("   ")).toBeNull()
  })

  it("tolerates surrounding whitespace", () => {
    expect(isSerialisedEditionType("  Limited Edition  ")).toBe(true)
    expect(isSerialisedEditionType(" Open Edition ")).toBe(false)
  })

  it("the two vocabularies are disjoint", () => {
    for (const t of SERIALISED_PINNACLE_EDITION_TYPES) {
      expect(KNOWN_UNSERIALISED_PINNACLE_EDITION_TYPES.has(t), t).toBe(false)
    }
  })
})
