// Collection chrome must not assert a live market on a collection that has one
// no longer.
//
// MEASURED IN PRODUCTION 2026-09-06 on /ufc/overview, in the SERVER-RENDERED
// HTML, on a collection whose Flow market last traded 13 May 2026:
//   · a brand-red pill reading literally "LIVE", at the top of every tab;
//   · ticker items "COLLECTION ANALYZER — FMV + active listing prices" and
//     "SNIPER — fight moments below market";
//   · Tools cards "Real-time deals below FMV" and "FMV · Flowty asks · badge
//     intel".
//
// ⚠ THIS IS THE SECOND ROUND ON ONE DEFECT. The /ufc/sniper header was fixed
// hours earlier the same evening; these are four more panels of the same claim
// on a page that fix never touched. That is the CLAUDE.md rule "fix per PANEL,
// not per page" — and the reason this guard walks SURFACES rather than pinning
// the one string that was found first.
//
// ⚠ MarketplaceStatusBanner does not discharge any of it: it resolves its
// status client-side, so the shell a reader or crawler receives first carries
// these with nothing beside them.
//
// WHAT IS PINNED — the property, over the cross product of every entry in
// CLOSED_MARKETS and every surface:
//   1. no liveness token survives;
//   2. the ticker names the venue and the closure date;
//   3. a live collection is UNCHANGED (the no-change control — a fix that had
//      quietly become a global rewrite would satisfy (1) and (2) perfectly);
//   4. populations are asserted, so nothing passes by iterating nothing.
//
// ⚠ CLOSED_TOOL_CARD_DESC is the SUPPRESSION LIST, NOT THE RULE. A tool card
// with no closed-market override falls through to its live copy, which is
// correct for cards that make no market claim and is CAUGHT HERE for any that
// do — so a new card carrying a trading claim reds this instead of shipping.

import { describe, it, expect } from "vitest"
import { CLOSED_MARKETS, closedMarket, formatClosedOn } from "@/lib/market-closed"
import {
  tickerStatusLabel,
  tickerItems,
  toolCardDesc,
  TOOL_CARD_DESC,
  TICKER_STATUS_LIVE,
  TICKER_STATUS_CLOSED,
} from "@/lib/collection/closed-market-chrome"
import { MARKET_LIVENESS_CLAIM } from "./helpers/market-liveness"

// ⚠ ONE shared pattern (helpers/market-liveness.ts), not a local copy. Three
// guards each declared their own on 2026-09-06 and they had already drifted;
// worse, the shared one's first version used `\bactive\b` and could not match
// "actively", so a positive control that SHOULD have failed passed. That
// pattern is pinned by its own test now.
const LIVENESS = MARKET_LIVENESS_CLAIM

// A representative live-market ticker list, shaped like the ones in
// components/collection-chrome.tsx (they are the input this replaces).
const LIVE_TICKER = [
  "⚡ COLLECTION ANALYZER — FMV + active listing prices",
  "⚡ SNIPER — fight moments below market",
  "⚡ ANALYTICS — portfolio tracking",
]

describe("closed-market collection chrome", () => {
  const closedSlugs = Object.keys(CLOSED_MARKETS)
  const toolPages = Object.keys(TOOL_CARD_DESC)

  it("has closed markets and tool cards to check (population control)", () => {
    expect(closedSlugs.length).toBeGreaterThan(0)
    expect(toolPages.length).toBeGreaterThan(0)
  })

  it("the ticker pill stops saying LIVE", () => {
    for (const slug of closedSlugs) {
      expect(tickerStatusLabel(slug), slug).toBe(TICKER_STATUS_CLOSED)
      expect(tickerStatusLabel(slug)).not.toMatch(LIVENESS)
    }
  })

  it("ticker items carry no liveness token and do name the closure", () => {
    let checked = 0
    for (const slug of closedSlugs) {
      const cm = closedMarket(slug)!
      const items = tickerItems(slug, LIVE_TICKER)
      expect(items.length, `${slug}: empty ticker`).toBeGreaterThan(0)
      for (const item of items) {
        expect(item, `${slug}: "${item}"`).not.toMatch(LIVENESS)
        checked += 1
      }
      const joined = items.join(" ")
      expect(joined).toContain(cm.venue.toUpperCase())
      expect(joined).toContain(formatClosedOn(cm.closedOn).toUpperCase())
      // …and it must not simply be the live list handed back.
      expect(items).not.toEqual(LIVE_TICKER)
    }
    expect(checked).toBeGreaterThanOrEqual(closedSlugs.length)
  })

  it("no tool-card description makes a trading claim on a closed market", () => {
    let checked = 0
    for (const slug of closedSlugs) {
      for (const page of toolPages) {
        const desc = toolCardDesc(page, slug)
        // Non-vacuous: every card must actually produce copy.
        expect(desc.length, `${slug}/${page}: empty desc`).toBeGreaterThan(0)
        expect(desc, `${slug}/${page}: "${desc}"`).not.toMatch(LIVENESS)
        checked += 1
      }
    }
    expect(checked).toBe(closedSlugs.length * toolPages.length)
  })

  it("NO-CHANGE CONTROL — live collections keep their chrome exactly", () => {
    for (const slug of ["nba-top-shot", "nfl-all-day", "laliga-golazos"]) {
      expect(tickerStatusLabel(slug), slug).toBe(TICKER_STATUS_LIVE)
      expect(tickerItems(slug, LIVE_TICKER), slug).toEqual(LIVE_TICKER)
      for (const page of toolPages) {
        expect(toolCardDesc(page, slug), `${slug}/${page}`).toBe(TOOL_CARD_DESC[page])
      }
    }
  })

  it("the Pinnacle listing-feed override survives the move out of the component", () => {
    // It was an inline ternary before this refactor; losing it silently would
    // put "Flowty asks" on a collection that has never used Flowty.
    expect(toolCardDesc("collection", "disney-pinnacle")).toBe("FMV · listing prices · deal finder")
    expect(toolCardDesc("collection", "nba-top-shot")).toBe("FMV · Flowty asks · badge intel")
  })
})

describe("the chrome surfaces render the derivation, not literals", () => {
  // Ban at zero on the two source files. The case history is that all of these
  // WERE inline literals, and re-inlining one is the failure mode a value-level
  // test cannot see.
  //
  // ⚠ No strip-comments here, deliberately: that helper has failed silently
  // three times and its failure mode is a FALSE GREEN. The patterns banned
  // below were chosen to be absent from these files' prose too, so the check
  // works on raw source. A comment quoting one in full would red it — a false
  // RED, which is the safe direction.
  const read = async (p: string) => (await import("node:fs")).readFileSync(p, "utf8")

  it("collection-chrome.tsx renders a derived pill label", async () => {
    const src = await read("components/collection-chrome.tsx")
    expect(src.length).toBeGreaterThan(1000)
    expect(src).toContain("tickerStatusLabel")
    expect(src).toContain("tickerItems(")
    expect(src).not.toMatch(/>LIVE</)
  })

  it("the overview Tools grid renders derived descriptions", async () => {
    const src = await read("app/(collections)/[collection]/overview/CollectionOverviewClient.tsx")
    expect(src.length).toBeGreaterThan(1000)
    expect(src).toContain("toolCardDesc(")
    expect(src).not.toMatch(/Real-time deals below FMV/)
    expect(src).not.toMatch(/Flowty asks/)
  })
})
