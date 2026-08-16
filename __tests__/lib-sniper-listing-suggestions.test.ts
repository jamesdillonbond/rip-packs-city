import { describe, it, expect } from "vitest"
import {
  buildListingSuggestions,
  suggestionsState,
  SUGGESTION_LIMIT,
  type OwnedMoment,
} from "@/lib/sniper/listing-suggestions"
import type { SniperDeal } from "@/lib/sniper/types"

// The Listing Suggestions panel on the sniper page.
//
// ⚠ ITS EMPTY STATE IS NOT AN EMPTY STATE, IT IS A CONCLUSION: "No listing
// suggestions found. Your moments are priced at or below current market asks."
// Three failure paths used to produce that sentence — a non-2xx snapshot read,
// a thrown fetch, and the deals feed not having loaded — so a collector could
// be told a specific analytical fact about their own portfolio that we never
// computed. And it is actionable in the direction of INACTION: it tells them
// not to re-list.
//
// All of it lived inline in a 1,790-line `"use client"` page.tsx, measured by
// neither coverage gate.

function deal(p: Partial<SniperDeal> & { editionKey: string; askPrice: number }): SniperDeal {
  return { ...p } as SniperDeal
}

const OWNED: OwnedMoment[] = [
  { editionKey: "1:1", playerName: "Damian Lillard", serialNumber: 7, fmv: 100 },
]

describe("buildListingSuggestions", () => {
  it("suggests a Moment whose edition is listed ABOVE the owner's FMV", () => {
    const out = buildListingSuggestions(OWNED, [deal({ editionKey: "1:1", askPrice: 150 })])
    expect(out).toEqual([{ player: "Damian Lillard", serial: 7, pctAbove: 50 }])
  })

  it("an ask AT the owner's FMV is NOT a suggestion", () => {
    // ⚠ Strictly greater. Including equality pads the panel with `pctAbove: 0`
    // rows — a "suggestion" with no upside, i.e. the panel making work for the
    // reader out of a non-event.
    expect(buildListingSuggestions(OWNED, [deal({ editionKey: "1:1", askPrice: 100 })])).toEqual([])
    expect(buildListingSuggestions(OWNED, [deal({ editionKey: "1:1", askPrice: 99 })])).toEqual([])
  })

  it("SKIPS a Moment with no FMV rather than treating it as zero", () => {
    // ⚠ `fmv = 0` divides by zero, and before that makes every ask look
    // infinitely above it — so an UNPRICED Moment would top the list precisely
    // because we know nothing about it. The old inline `m.fmv &&` guard got
    // this right by accident (0 and null are both falsy); it is asserted here
    // so a future `m.fmv != null` "fix" cannot quietly reintroduce it.
    for (const fmv of [null, undefined, 0]) {
      const out = buildListingSuggestions(
        [{ editionKey: "1:1", playerName: "X", serialNumber: 1, fmv: fmv as number | null }],
        [deal({ editionKey: "1:1", askPrice: 150 })],
      )
      expect(out, `fmv=${String(fmv)}`).toEqual([])
    }
  })

  it("ignores a Moment with no live listing, and a listing the owner does not hold", () => {
    const out = buildListingSuggestions(
      [
        { editionKey: "1:1", playerName: "Held", serialNumber: 1, fmv: 10 },
        { editionKey: "9:9", playerName: "Unlisted", serialNumber: 2, fmv: 10 },
      ],
      [deal({ editionKey: "1:1", askPrice: 20 }), deal({ editionKey: "7:7", askPrice: 999 })],
    )
    expect(out.map((r) => r.player)).toEqual(["Held"])
  })

  it("a Moment with no editionKey matches nothing rather than an empty-keyed deal", () => {
    // The lookup key is `m.editionKey ?? ""`; a deal keyed on the empty string
    // would otherwise pair with every unkeyed Moment the snapshot returns.
    const out = buildListingSuggestions(
      [{ editionKey: null, playerName: "Nameless", serialNumber: 1, fmv: 10 }],
      [deal({ editionKey: "", askPrice: 99 })],
    )
    expect(out).toEqual([])
  })

  it("ranks by the BIGGEST gap and caps at the limit, taking the TOP of the order", () => {
    // ⚠ The slice comes AFTER the sort. Rows are supplied WORST-FIRST so a
    // pre-sort slice would keep the wrong SET, not merely the wrong order —
    // the silently-sliced-ranking class.
    const owned: OwnedMoment[] = Array.from({ length: SUGGESTION_LIMIT + 3 }, (_, i) => ({
      editionKey: `e${i}`,
      playerName: `P${i}`,
      serialNumber: i,
      fmv: 100,
    }))
    const deals = owned.map((m, i) => deal({ editionKey: m.editionKey!, askPrice: 101 + i }))
    const out = buildListingSuggestions(owned, deals)
    expect(out).toHaveLength(SUGGESTION_LIMIT)
    expect(out[0].player, "the biggest gap leads").toBe(`P${SUGGESTION_LIMIT + 2}`)
    expect(out.map((r) => r.player)).not.toContain("P0")
  })

  it("falls back to readable placeholders rather than rendering undefined", () => {
    const out = buildListingSuggestions(
      [{ editionKey: "1:1", playerName: null, serialNumber: null, fmv: 100 }],
      [deal({ editionKey: "1:1", askPrice: 200 })],
    )
    expect(out).toEqual([{ player: "Unknown", serial: 0, pctAbove: 100 }])
  })

  it("an owner with nothing, or a market with nothing, yields nothing", () => {
    expect(buildListingSuggestions([], [deal({ editionKey: "1:1", askPrice: 1 })])).toEqual([])
    expect(buildListingSuggestions(OWNED, [])).toEqual([])
  })
})

describe("suggestionsState", () => {
  it("a FAILED collection read is read-failed, never 'none'", () => {
    // ⚠ THE DEFECT. `none` publishes "Your moments are priced at or below
    // current market asks" — a claim we can only make after comparing.
    expect(suggestionsState({ ownedMoments: null, deals: [], resultCount: 0 })).toBe("read-failed")
  })

  it("read-failed WINS over a missing market — we could not even get their side", () => {
    // Ordering matters: reporting `no-market` here would blame the feed for a
    // failure on the reader's own collection, pointing them at the wrong thing.
    expect(suggestionsState({ ownedMoments: null, deals: null, resultCount: 0 })).toBe("read-failed")
  })

  it("no loaded deals feed is no-market, never 'none'", () => {
    // Nothing to compare against is not the same as having compared and found
    // nothing — and unlike read-failed it resolves on its own in a few seconds.
    expect(suggestionsState({ ownedMoments: OWNED, deals: null, resultCount: 0 })).toBe("no-market")
    expect(suggestionsState({ ownedMoments: OWNED, deals: undefined, resultCount: 0 })).toBe("no-market")
  })

  it("a real comparison that found nothing IS 'none' — the conclusion survives", () => {
    // The mirror-image defect. When both sides loaded, "your Moments are priced
    // at or below current asks" is TRUE and useful; routing it into a failure
    // notice would hide a real answer behind a false apology.
    expect(suggestionsState({ ownedMoments: OWNED, deals: [], resultCount: 0 })).toBe("none")
  })

  it("an EMPTY collection that read fine is still 'none', not a failure", () => {
    // A collector who holds nothing gets `topMoments: []` at HTTP 200.
    expect(suggestionsState({ ownedMoments: [], deals: [], resultCount: 0 })).toBe("none")
  })

  it("results present is ok", () => {
    expect(suggestionsState({ ownedMoments: OWNED, deals: [], resultCount: 3 })).toBe("ok")
  })
})
