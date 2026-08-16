import { describe, it, expect } from "vitest"
import {
  listingsStatus,
  listingsNote,
  discountPct,
  editionPageUrl,
  absoluteEditionPageUrl,
  markSpecialSerials,
  editionFloorViewFor,
  isCanonicalEditionKey,
  keepCanonicalEditions,
  keepCanonicalEditionRows,
} from "@/lib/concierge/edition-listings"

// The whole point of this module is that "we could not check" and "nothing is
// listed" are DIFFERENT answers. The concierge told a real collector that a
// Lillard Archive Set moment was "not showing a current listing in the live
// feed — meaning nothing may be listed right now" when what had actually
// happened is that the floor lookup never reached the marketplace. Every test
// below exists to keep those two apart.

describe("listingsStatus — the three-way distinction", () => {
  it("reports 'unavailable' when the marketplace was not reached, whatever the counts say", () => {
    expect(listingsStatus(false, 0, null)).toBe("unavailable")
    // ⚠ Even if stale/garbage counts come back alongside the failure, a lookup
    // we could not complete can never be an answer about the market.
    expect(listingsStatus(false, 7, 12.5)).toBe("unavailable")
  })

  it("reports 'none_listed' ONLY when the marketplace answered with an empty book", () => {
    expect(listingsStatus(true, 0, null)).toBe("none_listed")
  })

  it("reports 'listed' when there are asks", () => {
    expect(listingsStatus(true, 3, 12.5)).toBe("listed")
  })

  it("treats a floor with no count (and vice versa) as listed, not empty", () => {
    // forSaleCount and lowestAsk are populated independently upstream; a
    // missing one is not evidence of an empty book, and calling it 'none_listed'
    // would be a false market claim.
    expect(listingsStatus(true, 0, 12.5)).toBe("listed")
    expect(listingsStatus(true, 2, null)).toBe("listed")
  })

  it("does not treat a zero/negative floor as a real ask", () => {
    expect(listingsStatus(true, 0, 0)).toBe("none_listed")
  })
})

describe("listingsNote — the wording cannot drift from the measurement", () => {
  it("forbids the false claim on 'unavailable' and names the required disclosure", () => {
    const note = listingsNote("unavailable", "the Top Shot marketplace")
    expect(note).toMatch(/could NOT reach/i)
    expect(note).toMatch(/do NOT say nothing is listed/i)
    // Must also block the other tempting substitution: quoting FMV as a price.
    expect(note).toMatch(/do NOT present fmv as a listing price/i)
  })

  it("licenses the plain answer on 'none_listed'", () => {
    const note = listingsNote("none_listed", "the Top Shot marketplace")
    expect(note).toMatch(/NO live asks/i)
    expect(note).toMatch(/real answer/i)
    // Must NOT carry the unavailable-case prohibition, or the model will hedge
    // a genuine, useful answer into uselessness.
    expect(note).not.toMatch(/could NOT reach/i)
  })

  it("marks a live floor as a snapshot rather than a quote", () => {
    expect(listingsNote("listed", "the Top Shot marketplace")).toMatch(/snapshot, not a quote/i)
  })

  it("names the venue it is talking about", () => {
    expect(listingsNote("none_listed", "a live marketplace")).toContain("a live marketplace")
  })
})

describe("discountPct", () => {
  it("computes percent below FMV to one decimal", () => {
    expect(discountPct(75, 100)).toBe(25)
    expect(discountPct(66.67, 100)).toBe(33.3)
  })

  it("returns null rather than a fabricated number when either side is missing", () => {
    expect(discountPct(null, 100)).toBeNull()
    expect(discountPct(75, null)).toBeNull()
  })

  it("returns null on a zero/negative FMV instead of dividing by it", () => {
    // The `|| 1` divide-by-zero guard this repo has already been bitten by
    // would turn a $0 basis into a 7,400% discount.
    expect(discountPct(75, 0)).toBeNull()
    expect(discountPct(75, -5)).toBeNull()
    expect(discountPct(0, 100)).toBeNull()
  })

  it("reports a negative discount when the ask is ABOVE FMV rather than clamping", () => {
    // An over-FMV ask is exactly the case the deal boards silently drop; the
    // whole reason this tool exists is to surface it honestly.
    expect(discountPct(150, 100)).toBe(-50)
  })
})

describe("edition links", () => {
  it("percent-encodes the colon in a Top Shot edition key", () => {
    // A raw colon in a path segment is what produced the half-escaped URLs in
    // earlier bot replies.
    expect(editionPageUrl("nba-top-shot", "48:1652")).toBe("/nba-top-shot/edition/48%3A1652")
  })

  it("builds an absolute URL without doubling the slash", () => {
    expect(absoluteEditionPageUrl("https://www.rippackscity.com/", "nba-top-shot", "48:1652")).toBe(
      "https://www.rippackscity.com/nba-top-shot/edition/48%3A1652",
    )
    expect(absoluteEditionPageUrl("https://www.rippackscity.com", "nba-top-shot", "48:1652")).toBe(
      "https://www.rippackscity.com/nba-top-shot/edition/48%3A1652",
    )
  })
})

describe("markSpecialSerials", () => {
  const buy = (id: string | null) => (id ? `https://nbatopshot.com/moment/${id}` : null)

  it("labels #1 and perfect mints and attaches a buy link", () => {
    const out = markSpecialSerials(
      [
        { serial_number: 1, ask_usd: "10", serial_fmv_usd: "20", nft_id: "a" },
        { serial_number: 50, ask_usd: "30", serial_fmv_usd: "25", nft_id: "b" },
      ],
      50,
      buy,
    )
    const first = out.find((s) => s.serial === 1)!
    const perfect = out.find((s) => s.serial === 50)!
    expect(first.is_first_mint).toBe(true)
    expect(first.is_perfect_mint).toBe(false)
    expect(first.discount_pct).toBe(50)
    expect(first.buy_url).toBe("https://nbatopshot.com/moment/a")
    expect(perfect.is_perfect_mint).toBe(true)
    expect(perfect.discount_pct).toBe(-20) // listed above serial FMV, stated honestly
  })

  it("never claims a perfect mint when circulation is unknown", () => {
    // is_perfect_mint is the claim that makes a moment worth many multiples of
    // floor — a false positive here is a false valuation.
    const out = markSpecialSerials(
      [{ serial_number: 50, ask_usd: "30", serial_fmv_usd: null, nft_id: "b" }],
      null,
      buy,
    )
    expect(out[0].is_perfect_mint).toBe(false)
    expect(out[0].serial_fmv).toBeNull()
    expect(out[0].discount_pct).toBeNull()
  })

  it("drops rows with no serial rather than inventing one", () => {
    const out = markSpecialSerials(
      [{ serial_number: null, ask_usd: "5", serial_fmv_usd: "5", nft_id: "c" }],
      100,
      buy,
    )
    expect(out).toHaveLength(0)
  })

  it("sorts chase serials first so a truncated list never drops the #1", () => {
    const out = markSpecialSerials(
      [
        { serial_number: 900, ask_usd: "1", serial_fmv_usd: "2", nft_id: "cheap" },
        { serial_number: 1, ask_usd: "999", serial_fmv_usd: "2000", nft_id: "one" },
      ],
      1000,
      buy,
    )
    expect(out[0].serial).toBe(1)
  })

  it("sorts by price, and an unpriced row does not present as the cheapest", () => {
    // ⚠ The null-ask row must be NON-chase, or the chase-first comparator sorts
    // it to the front anyway and the assertion proves nothing about null
    // handling. A first draft put the null on the #1 and `?? Infinity` -> `?? 0`
    // survived mutation because of exactly that.
    const out = markSpecialSerials(
      [
        { serial_number: 10, ask_usd: null, serial_fmv_usd: null, nft_id: "unpriced" },
        { serial_number: 11, ask_usd: "5", serial_fmv_usd: "9", nft_id: "y" },
        { serial_number: 12, ask_usd: "3", serial_fmv_usd: "9", nft_id: "z" },
      ],
      1000,
      buy,
    )
    expect(out.map((s) => s.buy_url?.split("/").pop())).toEqual(["z", "y", "unpriced"])
  })

  it("keeps the chase row first even when it is the most expensive AND unpriced rows exist", () => {
    const out = markSpecialSerials(
      [
        { serial_number: 10, ask_usd: null, serial_fmv_usd: null, nft_id: "unpriced" },
        { serial_number: 1, ask_usd: "999", serial_fmv_usd: "2000", nft_id: "one" },
        { serial_number: 12, ask_usd: "3", serial_fmv_usd: "9", nft_id: "z" },
      ],
      1000,
      buy,
    )
    expect(out.map((s) => s.buy_url?.split("/").pop())).toEqual(["one", "z", "unpriced"])
  })

  it("tolerates a null nft_id without emitting a broken link", () => {
    const out = markSpecialSerials(
      [{ serial_number: 1, ask_usd: "10", serial_fmv_usd: "20", nft_id: null }],
      100,
      buy,
    )
    expect(out[0].buy_url).toBeNull()
  })
})

describe("editionFloorViewFor — which collections have an edition-keyed book", () => {
  it("maps All Day and Golazos to their on-chain floor views", () => {
    expect(editionFloorViewFor("nfl-all-day")).toBe("allday_edition_floor_ask")
    expect(editionFloorViewFor("laliga-golazos")).toBe("golazos_edition_floor_ask")
  })

  it("returns null for collections with no edition-keyed book", () => {
    // Pinnacle's asks are RENDER-keyed in the pinnacle_* tables; UFC's Flow
    // market is closed. Both must fall through rather than be given a view
    // that would silently return nothing and read as "no open ask".
    expect(editionFloorViewFor("disney-pinnacle")).toBeNull()
    expect(editionFloorViewFor("ufc")).toBeNull()
    expect(editionFloorViewFor("nba-top-shot")).toBeNull() // uses the GQL path
  })

  it("returns null for absent / prototype-inherited keys rather than a truthy member", () => {
    expect(editionFloorViewFor(null)).toBeNull()
    expect(editionFloorViewFor(undefined)).toBeNull()
    expect(editionFloorViewFor("")).toBeNull()
    // A bare index would hand back Object.prototype.toString as a "view name".
    expect(editionFloorViewFor("toString")).toBeNull()
    expect(editionFloorViewFor("constructor")).toBeNull()
  })
})

describe("canonical-edition predicate — the dual-key trap", () => {
  it("keeps the int-keyed Top Shot row and drops its UUID-keyed twin", () => {
    // The exact pair behind a live wrong answer: one moment, two rows,
    // presented to a user as two editions from two different collections.
    const rows = [
      { external_id: "48:1652" },
      { external_id: "9e89b552-0236-4ffc-ab6b-8cf7c27d46b4:d01a3af4-dce1-499a-94d0-4104befb5b40" },
    ]
    expect(keepCanonicalEditions(rows, "nba-top-shot")).toEqual([{ external_id: "48:1652" }])
  })

  it("keeps subedition parallels — the regex must NOT be end-anchored", () => {
    // `$` would drop every setID:playID::subID parallel (Hexwave/Jukebox),
    // which are canonical. That reads as a coverage collapse, not a bad query.
    expect(isCanonicalEditionKey("48:1652::3", "nba-top-shot")).toBe(true)
    expect(keepCanonicalEditions([{ external_id: "48:1652::3" }], "nba-top-shot")).toHaveLength(1)
  })

  it("is a NO-OP for every other collection, whose own keys are UUIDs", () => {
    // ⚠ Applying the predicate globally returns ZERO rows for these — measured
    // 2026-08-15, All Day / Golazos / UFC / Candy are 100% non-int-keyed.
    const uuidRow = [{ external_id: "9e89b552-0236-4ffc-ab6b-8cf7c27d46b4" }]
    for (const slug of ["nfl-all-day", "laliga-golazos", "ufc", "candy-mlb", "disney-pinnacle"]) {
      expect(keepCanonicalEditions(uuidRow, slug)).toHaveLength(1)
      expect(isCanonicalEditionKey("anything-at-all", slug)).toBe(true)
    }
  })

  it("does not collapse two DIFFERENT moments that share player/set/tier", () => {
    // Filtering by key convention, not de-duplicating by name: one player can
    // have several plays in a set, and collapsing on those fields would hide a
    // real second edition.
    const rows = [{ external_id: "48:1652" }, { external_id: "48:1999" }]
    expect(keepCanonicalEditions(rows, "nba-top-shot")).toHaveLength(2)
  })

  it("treats a missing key on Top Shot as non-canonical rather than keeping it", () => {
    expect(isCanonicalEditionKey(null, "nba-top-shot")).toBe(false)
    expect(isCanonicalEditionKey(undefined, "nba-top-shot")).toBe(false)
    expect(isCanonicalEditionKey("", "nba-top-shot")).toBe(false)
  })
})

describe("keepCanonicalEditionRows — the CROSS-COLLECTION case", () => {
  const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
  const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"

  it("judges each row by its OWN collection, so one query can mix both conventions", () => {
    // ⚠ The slug form cannot do this. Passing null would let Top Shot's twins
    // through; passing "nba-top-shot" would delete every All Day row, since
    // All Day is 100% UUID-keyed.
    const rows = [
      { external_id: "48:1652", collection_id: TS },                       // canonical TS
      { external_id: "9e89b552-0236:d01a3af4-dce1", collection_id: TS },   // TS twin
      { external_id: "9e89b552-0236-4ffc-ab6b", collection_id: AD },       // All Day, legitimately UUID
    ]
    const kept = keepCanonicalEditionRows(rows, TS)
    expect(kept.map((r) => r.collection_id)).toEqual([TS, AD])
    expect(kept.map((r) => r.external_id)).toEqual(["48:1652", "9e89b552-0236-4ffc-ab6b"])
  })

  it("keeps a Top Shot subedition parallel", () => {
    const rows = [{ external_id: "48:1652::3", collection_id: TS }]
    expect(keepCanonicalEditionRows(rows, TS)).toHaveLength(1)
  })

  it("treats a null external_id on a Top Shot row as non-canonical", () => {
    expect(keepCanonicalEditionRows([{ external_id: null, collection_id: TS }], TS)).toHaveLength(0)
    // ...but a null key on another collection is not this predicate's business.
    expect(keepCanonicalEditionRows([{ external_id: null, collection_id: AD }], TS)).toHaveLength(1)
  })
})
