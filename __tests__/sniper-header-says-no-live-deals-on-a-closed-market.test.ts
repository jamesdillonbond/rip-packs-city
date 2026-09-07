// The Sniper header must not advertise LIVE DEALS on a market that has closed.
//
// FOUND 2026-09-06 IN PRODUCTION, in the SERVER-RENDERED HTML of
// /ufc/sniper: `LIVE DEALS BELOW ADJUSTED FMV — BADGE-AWARE, SERIAL-ADJUSTED`,
// on a collection whose Flow market last traded 2026-05-13. It is the sharpest
// shape in the honesty canon — a claim about the MARKET made out of a fact
// about our own template — and it also offers an action the product cannot
// perform there, which the read-only rule forbids.
//
// ⚠ THE BANNER IS NOT THE FIX, and this file exists partly to record why.
// `MarketplaceStatusBanner` sits lower on the same page but resolves its status
// client-side: the shell a reader or a crawler receives first carries the false
// line with nothing beside it, and a failed banner fetch never corrects it. So
// the assertion below is on the SYNCHRONOUS copy.
//
// ⚠ THE PROPERTY, NOT THE SPELLING. The banned thing is the word LIVE (and any
// other present-tense market claim) on a closed slug — not this particular
// sentence — and it is asserted over every entry in CLOSED_MARKETS rather than
// over "ufc", so a second closure inherits the guard.

import { describe, it, expect } from "vitest"
import { CLOSED_MARKETS, closedMarket, formatClosedOn } from "@/lib/market-closed"
import {
  sniperSubtitle,
  SNIPER_SUBTITLE_DEFAULT,
  SNIPER_SUBTITLE_PINNACLE,
} from "@/lib/sniper/header-copy"
import { MARKET_LIVENESS_CLAIM } from "./helpers/market-liveness"

// ⚠ ONE shared pattern (helpers/market-liveness.ts), not a local copy. Three
// guards each declared their own on 2026-09-06 and they had already drifted;
// worse, the shared one's first version used `\bactive\b` and could not match
// "actively", so a positive control that SHOULD have failed passed. That
// pattern is pinned by its own test now.
const LIVENESS = MARKET_LIVENESS_CLAIM

describe("sniper header subtitle", () => {
  const closedSlugs = Object.keys(CLOSED_MARKETS)

  it("has closed markets to check (population control)", () => {
    expect(closedSlugs.length).toBeGreaterThan(0)
  })

  it("no closed market gets a liveness claim, and every one names its closure", () => {
    let checked = 0
    for (const slug of closedSlugs) {
      const cm = closedMarket(slug)!
      // Both branches of the live-market ternary, so a closed market cannot slip
      // through on the Pinnacle path either.
      for (const isPinnacle of [false, true]) {
        const line = sniperSubtitle(slug, isPinnacle)
        expect(line, `${slug} (pinnacle=${isPinnacle})`).not.toMatch(LIVENESS)
        expect(line).toContain(cm.venue.toUpperCase())
        expect(line).toContain(formatClosedOn(cm.closedOn).toUpperCase())
        checked += 1
      }
    }
    expect(checked).toBe(closedSlugs.length * 2)
  })

  it("a LIVE market keeps its copy — the closed branch is not a global rewrite", () => {
    // The no-change control. Without it, a helper that returned the closed line
    // for everyone would satisfy the case above while breaking four collections.
    expect(sniperSubtitle("nba-top-shot", false)).toBe(SNIPER_SUBTITLE_DEFAULT)
    expect(sniperSubtitle("disney-pinnacle", true)).toBe(SNIPER_SUBTITLE_PINNACLE)
    expect(sniperSubtitle("nfl-all-day", false)).toBe(SNIPER_SUBTITLE_DEFAULT)
  })

  it("the closed line differs from both live lines, so the fix is not a no-op", () => {
    const closed = sniperSubtitle(closedSlugs[0]!, false)
    expect(closed).not.toBe(SNIPER_SUBTITLE_DEFAULT)
    expect(closed).not.toBe(SNIPER_SUBTITLE_PINNACLE)
  })
})

describe("SniperClient renders the derived subtitle, not a literal", () => {
  // Ban at zero on the component itself: the case history is that this line was
  // an inlined ternary, and the failure mode being guarded against is someone
  // re-inlining it. Reading the source is the only way to see that from a unit
  // test — mounting SniperClient in jsdom would need the whole feed fan-out.
  it("the sniper page source contains no hardcoded LIVE DEALS subtitle", async () => {
    const fs = await import("node:fs")
    const src = fs.readFileSync(
      "app/(collections)/[collection]/sniper/SniperClient.tsx",
      "utf8",
    )
    // Non-vacuous: the file must exist and be the real component.
    expect(src.length).toBeGreaterThan(1000)
    expect(src).toContain("sniperSubtitle")
    // ⚠ NO strip-comments here, deliberately. CLAUDE.md records that helper
    // failing SILENTLY three times (a nested template literal once blanked the
    // code and KEPT the comments) — and its failure mode is a FALSE GREEN,
    // which is the worse direction for a ban. The standing advice is to prefer
    // a check that does not need it, so the banned patterns were chosen to be
    // absent from this file's prose too: the surviving comment says
    // `"LIVE DEALS" is a claim about the MARKET`, which matches neither.
    // A future comment that quotes the old subtitle in full would red this —
    // a false RED, which is the safe direction and is fixed by rewording it.
    expect(src).not.toMatch(/LIVE DEALS BELOW/)
    expect(src).not.toMatch(/LIVE PINNACLE DEALS/)
  })
})
