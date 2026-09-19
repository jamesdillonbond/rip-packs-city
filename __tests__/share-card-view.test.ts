import { describe, it, expect } from "vitest"
import { buildSeriesBars, closedMarketNote, shareHeadline, fullCollectionHref } from "@/lib/share-card-view"

describe("share-card-view · buildSeriesBars", () => {
  it("sorts series labels and returns the max for bar scaling", () => {
    const { entries, max } = buildSeriesBars({ "Series 3": 5, "Series 1": 12, "Series 2": 8 })
    expect(entries.map(([k]) => k)).toEqual(["Series 1", "Series 2", "Series 3"])
    expect(max).toBe(12)
  })

  it("names the RPC's null-series bucket and sorts it after the real series (was rendered 'SUnknown', 2026-09-04)", () => {
    const { entries } = buildSeriesBars({ SUnknown: 1414, S9: 132, S10: 3, S2: 2011 })
    expect(entries.map(([k]) => k)).toEqual(["S2", "S9", "S10", "No series"])
    expect(entries[3][1]).toBe(1414)
  })

  it("floors the max at 1 so an all-zero breakdown never divides by zero", () => {
    expect(buildSeriesBars({ "Series 1": 0 }).max).toBe(1)
    expect(buildSeriesBars({}).max).toBe(1)
    expect(buildSeriesBars({}).entries).toEqual([])
  })
})

describe("share-card-view · closedMarketNote", () => {
  it("returns null when no collection's market is closed", () => {
    expect(closedMarketNote([{ name: "Top Shot", market_closed_at: null }])).toBeNull()
    expect(closedMarketNote([])).toBeNull()
    expect(closedMarketNote(null)).toBeNull()
  })

  it("uses singular copy for exactly one closed market", () => {
    const note = closedMarketNote([
      { name: "UFC Strike", market_closed_at: "2026-05-01" },
      { name: "Top Shot", market_closed_at: null },
    ])
    expect(note).toBe(
      "UFC Strike market is closed — its moments are counted but excluded from Total FMV.",
    )
  })

  it("uses plural copy and joins names when multiple markets are closed", () => {
    const note = closedMarketNote([
      { name: "UFC Strike", market_closed_at: "2026-05-01" },
      { name: "Golazos", market_closed_at: "2026-06-01" },
    ])
    expect(note).toBe(
      "UFC Strike, Golazos markets are closed — their moments are counted but excluded from Total FMV.",
    )
  })
})

describe("share-card-view · shareHeadline (front door = total − stale, like the profile; 2026-09-04)", () => {
  it("headlines total minus stale and names the stale share in the caption", () => {
    const h = shareHeadline({ totalFmv: 98514.57, staleFmv: 50695.14, staleCount: 367 })
    expect(h.live).toBeCloseTo(47819.43, 2)
    expect(h.stale).toBeCloseTo(50695.14, 2)
    expect(h.caption).toBe("+ $50,695 across 367 stale-priced moments")
  })

  it("with NO stale split known (older API shape) shows the raw total and no caption — never a fabricated zero-stale claim", () => {
    const h = shareHeadline({ totalFmv: 1234.5 })
    expect(h.live).toBeCloseTo(1234.5, 2)
    expect(h.caption).toBeNull()
  })

  it("a known zero stale share has no caption; an empty wallet is $0 with no caption", () => {
    expect(shareHeadline({ totalFmv: 500, staleFmv: 0, staleCount: 0 }).caption).toBeNull()
    expect(shareHeadline({ totalFmv: 0, staleFmv: 0, staleCount: 0 }).live).toBe(0)
  })

  it("never goes negative and singularises one stale moment", () => {
    const h = shareHeadline({ totalFmv: 10, staleFmv: 25, staleCount: 1 })
    expect(h.live).toBe(0)
    expect(h.caption).toBe("+ $25 across 1 stale-priced moment")
  })
})

// 2026-09-06: the "Across Flow Collections" tiles reuse shareHeadline per
// collection so every figure on the card sits on ONE basis (total − stale).
// The founder's card printed NBA Top Shot $87,785 raw under a $50,223 headline.
describe("shareHeadline — per-collection tile basis", () => {
  it("renders a collection's live share and discloses its stale share", () => {
    const h = shareHeadline({ totalFmv: 87785, staleFmv: 42729, staleCount: 315 })
    expect(h.live).toBe(45056)
    expect(h.stale).toBe(42729)
    expect(h.caption).toContain("315 stale-priced moments")
  })
  it("a collection with no stale share renders its full total and no caption", () => {
    const h = shareHeadline({ totalFmv: 4013, staleFmv: 0, staleCount: 0 })
    expect(h.live).toBe(4013)
    expect(h.stale).toBe(0)
    expect(h.caption).toBeNull()
  })
  it("a tile with an unknown stale split (older API) still renders the total, never NaN", () => {
    const h = shareHeadline({ totalFmv: 879 })
    expect(h.live).toBe(879)
    expect(Number.isFinite(h.live)).toBe(true)
  })
})

// ⛔ "View Full Collection" was `/nba-top-shot/collection?wallet=<addr>` for
// EVERY wallet until 2026-09-19, so a Candy MLB holder was sent to the Top Shot
// tab to look at a collection they do not have. It now follows the wallet's own
// holdings — and, because not every collection ships a `collection` tab, it
// reads the registry rather than assuming the tab exists.
//
// ⭐ RE-PINNED LATER THE SAME DAY, and the turnover is the lesson. The Candy
// row below asserted `/candy-mlb/overview` because Candy had no Collection tab;
// hours later it shipped one, and this test went red on a PREMISE that had
// changed, not on a defect — so it is re-pinned to the now-true destination
// rather than inverted. ⚠ The property it exists to protect is NOT "Candy goes
// to overview", it is "the tab comes from the registry", so the fallback arm is
// kept alive by a collection that genuinely lacks the tab (Panini: overview +
// sniper). Delete that arm and this describe block stops proving anything.
describe("fullCollectionHref", () => {
  const W = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"

  it("sends a Candy-only wallet to Candy's OWN collection tab, now that it has one", () => {
    // Candy shipped pages: ["overview", "market", "collection"] on 2026-09-19.
    // ⚠ The base58 wallet must survive the round trip CASE-INTACT — a Solana
    // address is case-sensitive, so a lowercased href is a dead link, not a typo.
    expect(fullCollectionHref([{ slug: "candy_mlb", moments: 5 }], W)).toBe(
      `/candy-mlb/collection?wallet=${W}`,
    )
  })

  it("⚠ THE PROPERTY, not the row: a collection WITHOUT a `collection` tab still falls back to overview", () => {
    // Panini ships pages: ["overview", "sniper"]. This is the arm that makes the
    // registry read load-bearing; without it, `fullCollectionHref` could go back
    // to hardcoding `/<slug>/collection` and every assertion here would pass.
    expect(fullCollectionHref([{ slug: "panini_blockchain", moments: 7 }], "0xabc")).toBe(
      "/panini-blockchain/overview",
    )
  })

  it("no-change control: a Top Shot wallet still lands on the Top Shot collection tab", () => {
    expect(fullCollectionHref([{ slug: "nba_top_shot", moments: 120 }], "0xabc")).toBe(
      "/nba-top-shot/collection?wallet=0xabc",
    )
  })

  it("follows the DOMINANT collection when a wallet spans several", () => {
    expect(
      fullCollectionHref(
        [{ slug: "candy_mlb", moments: 5 }, { slug: "nfl_all_day", moments: 90 }],
        "0xabc",
      ),
    ).toBe("/nfl-all-day/collection?wallet=0xabc")
  })

  it("falls back to Top Shot rather than guessing when there is nothing to go on", () => {
    expect(fullCollectionHref([], "0xabc")).toBe("/nba-top-shot/collection?wallet=0xabc")
    expect(fullCollectionHref(undefined, "0xabc")).toBe("/nba-top-shot/collection?wallet=0xabc")
    // An unknown db slug must not produce "/undefined/..."
    expect(fullCollectionHref([{ slug: "not_a_collection", moments: 3 }], "0xabc")).toBe(
      "/nba-top-shot/collection?wallet=0xabc",
    )
  })

  it("does not fold a base58 wallet into the href", () => {
    expect(fullCollectionHref([{ slug: "nba_top_shot", moments: 1 }], W)).toContain(W)
  })
})

// ── The top-sales chip set and the API's 400-gate are two hardcoded lists ─────
// in two files, and nothing else forces them to agree. A chip whose value the
// API rejects is a filter button that returns an error; a valid collection with
// no chip is data the reader cannot reach. Both happened: Candy was missing from
// BOTH while `v_insights_top_sales` served its rows under collection=all.
describe("top-sales collection chips agree with the API's valid set", () => {
  it("every chip value is accepted by the API", async () => {
    const { TOP_SALES_VALID_COLLECTIONS } = await import("@/lib/insights/top-sales")
    // Kept in sync by hand with app/insights/top-sales/TopSalesBoardClient.tsx.
    const CHIPS = ["all", "nba_top_shot", "nfl_all_day", "candy_mlb"]
    for (const val of CHIPS) {
      if (val === "all") continue // "all" is the absence of a filter, not a value
      expect(
        TOP_SALES_VALID_COLLECTIONS.has(val),
        `chip "${val}" is not in TOP_SALES_VALID_COLLECTIONS — clicking it 400s`,
      ).toBe(true)
    }
  })

  it("candy_mlb is accepted, since the backing view already serves its rows", () => {
    // Measured 2026-09-19: v_insights_top_sales holds 7 candy_mlb rows in the
    // 30d window (top sale $203.72), and the endpoint was 400ing on them.
    return import("@/lib/insights/top-sales").then(({ TOP_SALES_VALID_COLLECTIONS }) => {
      expect(TOP_SALES_VALID_COLLECTIONS.has("candy_mlb")).toBe(true)
    })
  })
})
