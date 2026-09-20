import { describe, it, expect } from "vitest"
import {
  SORT_OPTIONS,
  COLLECTION_LABEL,
  formatUsd,
  formatPrice,
  formatNumber,
  formatPct,
  relativeTime,
  truncateAddr,
  isLinkableAddr,
  resolveCollectionLabel,
  resolveSortOption,
  isSparseListingCount,
  normalizeMarketplaceListings,
  normalizeDataCaveats,
} from "@/lib/analytics-listings-compute"

// Pins the pure formatting / address / sort / normalize logic lifted out of
// components/analytics/ListingsDashboard.tsx (invisible to the coverage ratchet).
// A regression here mis-formats the listings tables, mis-truncates wallets,
// mis-labels the sort dropdown, or lets a non-array RPC payload crash .map.

describe("formatUsd", () => {
  it("returns $0 for null/undefined/non-finite/non-positive", () => {
    expect(formatUsd(null)).toBe("$0")
    expect(formatUsd(undefined)).toBe("$0")
    expect(formatUsd(Number.NaN)).toBe("$0")
    expect(formatUsd(0)).toBe("$0")
    expect(formatUsd(-1)).toBe("$0")
  })
  it("abbreviates millions / thousands / sub-thousand", () => {
    expect(formatUsd(4_000_000)).toBe("$4.00M")
    expect(formatUsd(1_200)).toBe("$1.2k")
    expect(formatUsd(750)).toBe("$750")
  })
})

describe("formatPrice", () => {
  it("returns em-dash only for null/undefined/non-finite (0 and negatives DO format)", () => {
    expect(formatPrice(null)).toBe("—")
    expect(formatPrice(undefined)).toBe("—")
    expect(formatPrice(Number.NaN)).toBe("—")
    // Distinct from SalesDashboard.formatPrice: this variant renders 0 and negatives.
    expect(formatPrice(0)).toBe("$0.00")
    expect(formatPrice(-5)).toBe("$-5.00")
  })
  it("abbreviates >= 10k, whole dollars for 100..9999, 2 decimals under 100", () => {
    expect(formatPrice(22_500)).toBe("$22.5k")
    expect(formatPrice(250)).toBe("$250")
    expect(formatPrice(12.5)).toBe("$12.50")
  })
})

describe("formatNumber", () => {
  it("returns 0 for null/undefined/non-finite/non-positive", () => {
    expect(formatNumber(null)).toBe("0")
    expect(formatNumber(0)).toBe("0")
    expect(formatNumber(-2)).toBe("0")
  })
  it("abbreviates and renders small counts", () => {
    expect(formatNumber(2_000_000)).toBe("2.00M")
    expect(formatNumber(1_500)).toBe("1.5k")
    expect(formatNumber(7)).toBe("7")
  })
})

describe("formatPct", () => {
  it("returns em-dash for null/undefined/non-finite", () => {
    expect(formatPct(null)).toBe("—")
    expect(formatPct(undefined)).toBe("—")
    expect(formatPct(Number.NaN)).toBe("—")
  })
  it("renders a whole-number percent", () => {
    expect(formatPct(12.4)).toBe("12%")
    expect(formatPct(0)).toBe("0%")
    expect(formatPct(-5.6)).toBe("-6%")
  })
})

describe("relativeTime", () => {
  const now = Date.parse("2026-07-25T12:00:00.000Z")

  it("returns em-dash for null/undefined and unparseable ISO", () => {
    expect(relativeTime(null, now)).toBe("—")
    expect(relativeTime(undefined, now)).toBe("—")
    expect(relativeTime("", now)).toBe("—")
    expect(relativeTime("not-a-date", now)).toBe("—")
  })
  it("renders 'just now' under a minute", () => {
    expect(relativeTime("2026-07-25T11:59:30.000Z", now)).toBe("just now")
  })
  it("renders minutes under an hour", () => {
    expect(relativeTime("2026-07-25T11:55:00.000Z", now)).toBe("5m ago")
  })
  it("renders hours under a day", () => {
    expect(relativeTime("2026-07-25T09:00:00.000Z", now)).toBe("3h ago")
  })
  it("renders days under 30 days", () => {
    expect(relativeTime("2026-07-23T12:00:00.000Z", now)).toBe("2d ago")
  })
  it("falls back to a locale date beyond 30 days", () => {
    const iso = "2026-06-01T12:00:00.000Z"
    expect(relativeTime(iso, now)).toBe(new Date(iso).toLocaleDateString())
  })
  it("defaults now to Date.now() when omitted", () => {
    // A far-past date is always in the locale-date branch regardless of the clock.
    const iso = "2000-01-01T00:00:00.000Z"
    expect(relativeTime(iso)).toBe(new Date(iso).toLocaleDateString())
  })
})

describe("truncateAddr", () => {
  it("returns em-dash for null/undefined/empty", () => {
    expect(truncateAddr(null)).toBe("—")
    expect(truncateAddr(undefined)).toBe("—")
    expect(truncateAddr("")).toBe("—")
  })
  it("lowercases and passes through non-0x or short strings unchanged", () => {
    expect(truncateAddr("StoreFront")).toBe("storefront")
    expect(truncateAddr("0x1234")).toBe("0x1234")
    expect(truncateAddr("0x12345678")).toBe("0x12345678") // length 10, boundary keeps it
  })
  it("truncates a full 0x address to head…tail", () => {
    expect(truncateAddr("0xABCDEF0123456789")).toBe("0xabcd…6789")
  })
})

describe("isLinkableAddr", () => {
  it("is true only for a 16-hex 0x address", () => {
    expect(isLinkableAddr("0x0123456789abcdef")).toBe(true)
    expect(isLinkableAddr("0xABCDEF0123456789")).toBe(true)
  })
  it("is false for null/short/long/non-hex", () => {
    expect(isLinkableAddr(null)).toBe(false)
    expect(isLinkableAddr(undefined)).toBe(false)
    expect(isLinkableAddr("0x1234")).toBe(false)
    expect(isLinkableAddr("0x0123456789abcdefff")).toBe(false)
    expect(isLinkableAddr("0xghijklmnopqrstuv")).toBe(false)
  })
})

describe("resolveCollectionLabel", () => {
  it("maps known short-codes case-insensitively", () => {
    expect(resolveCollectionLabel("topshot")).toBe("Top Shot")
    expect(resolveCollectionLabel("ALLDAY")).toBe("All Day")
    expect(resolveCollectionLabel("Ufc")).toBe("UFC")
  })
  it("falls back to the raw value for unknown codes and passes through nullish", () => {
    expect(resolveCollectionLabel("mystery")).toBe("mystery")
    expect(resolveCollectionLabel(null)).toBeNull()
    expect(resolveCollectionLabel(undefined)).toBeUndefined()
  })
  // ⭐ RE-PINNED 2026-09-20 (5 → 6 keys), and the title changed with it because
  // "all five collections" stopped being the property. The real property is
  // COMPLEMENTARITY: every key `analytics_listings_summary` can put in
  // `marketplace_listings.collection` must have a label, because
  // resolveCollectionLabel falls back to the RAW SLUG and /analytics/listings
  // would render a row literally labelled "candy_mlb".
  //
  // The RPC keys rows with `CASE c.slug WHEN … ELSE c.slug END`, so the emitted
  // set is {the five short codes} ∪ {the DB slug of any collection with no CASE
  // arm}. Candy joined it today when the RPC gained an arm reading
  // `candy_listings` (migration 20260920153900) — verified live the same hour:
  // analytics_listings_summary(NULL) → ["allday","candy_mlb","golazos","topshot"].
  it("COLLECTION_LABEL labels every key the listings RPC can emit", () => {
    expect(Object.keys(COLLECTION_LABEL).sort()).toEqual([
      "allday",
      "candy_mlb",
      "golazos",
      "pinnacle",
      "topshot",
      "ufc",
    ])
    // ⚠ NON-VACUITY: the list above is satisfied by a map of empty strings, so
    // assert the two shapes actually resolve — a short code and the one LONG
    // slug, which is the arm that was missing and the one a future collection
    // will land on.
    expect(resolveCollectionLabel("candy_mlb")).toBe("Candy MLB")
    expect(resolveCollectionLabel("topshot")).toBe("Top Shot")
    // …and the fall-through stays alive on a key no registry has, so it keeps
    // exercising the raw-slug branch rather than passing against a label.
    expect(resolveCollectionLabel("panini_blockchain")).toBe("panini_blockchain")
  })
})

describe("resolveSortOption", () => {
  it("returns the matching option", () => {
    expect(resolveSortOption("apr_asc").label).toBe("Lowest APR")
    expect(resolveSortOption("newest").label).toBe("Newest")
  })
  it("defaults to the first option for an unknown sort", () => {
    expect(resolveSortOption("bogus")).toBe(SORT_OPTIONS[0])
    expect(resolveSortOption("bogus").value).toBe("apr_desc")
  })
})

describe("isSparseListingCount", () => {
  it("is true for a small positive count", () => {
    expect(isSparseListingCount(0)).toBe(true)
    expect(isSparseListingCount(29)).toBe(true)
  })
  it("is false at/above 30 and for nullish", () => {
    expect(isSparseListingCount(30)).toBe(false)
    expect(isSparseListingCount(100)).toBe(false)
    expect(isSparseListingCount(null)).toBe(false)
    expect(isSparseListingCount(undefined)).toBe(false)
  })
})

describe("normalizeMarketplaceListings", () => {
  it("passes arrays through", () => {
    const rows = [{ collection: "topshot" }]
    expect(normalizeMarketplaceListings(rows)).toBe(rows)
  })
  it("coerces null/undefined/object payloads to []", () => {
    expect(normalizeMarketplaceListings(null)).toEqual([])
    expect(normalizeMarketplaceListings(undefined)).toEqual([])
    // The RPC's empty-payload footgun: {} typed as an array at the call site.
    expect(normalizeMarketplaceListings({} as unknown as unknown[])).toEqual([])
  })
})

describe("normalizeDataCaveats — the disclosure that had never rendered", () => {
  // 🚨 REGRESSION PIN, 2026-09-20. `analytics_listings_summary` emits
  // data_caveats as a jsonb OBJECT; ListingsSummaryResponse typed it `string[]`
  // and the dashboard gated the "About this data" section on
  // `data_caveats.length > 0`. On an object that is `undefined`, so the section
  // has NEVER rendered on /analytics/listings. The declared type was wrong about
  // the runtime shape, so tsc type-checked the lie and no test could see it.
  it("reads the OBJECT shape the RPC actually emits", () => {
    const live = {
      topshot_sample: "ts_listings is a recent sample of the Top Shot orderbook, not the full state",
      cached_sniper_bias: "cached_listings is sourced from Sniper deal scans - biased toward low-priced inventory",
      dead_listing_filter: "Dropped asks > 50x FMV (or > $100K when FMV unknown) to exclude listing-reward farming",
      candy_source: "Candy MLB asks come from candy_listings (Solana / Magic Eden), not cached_listings, and are a full active-ask snapshot rather than a Sniper-scan sample",
    }
    const out = normalizeDataCaveats(live)
    expect(out).toHaveLength(4)
    // ⚠ The Candy provenance sentence is the reason this was worth fixing now:
    // the table gained a row whose source is neither the Sniper feed nor Flow.
    expect(out.some((c) => c.includes("Magic Eden"))).toBe(true)
    // …and the guard the dashboard uses is now TRUE on the live payload, which
    // is the actual defect being pinned — not the array contents.
    expect(out.length > 0).toBe(true)
  })

  it("still accepts a list, in case a writer emits one", () => {
    expect(normalizeDataCaveats(["a", "b"])).toEqual(["a", "b"])
  })

  it("yields [] for nullish/garbage so the section hides rather than throwing", () => {
    expect(normalizeDataCaveats(null)).toEqual([])
    expect(normalizeDataCaveats(undefined)).toEqual([])
    expect(normalizeDataCaveats({})).toEqual([])
    // Non-string values are dropped, not rendered as "[object Object]".
    expect(normalizeDataCaveats({ a: "keep", b: 3 as unknown as string, c: "" })).toEqual(["keep"])
  })
})
