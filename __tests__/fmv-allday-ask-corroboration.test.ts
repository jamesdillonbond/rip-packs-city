import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import {
  escalateConfidence,
  MAX_ASK_AGE_HOURS_CORROBORATION,
  MIN_SALES_ASK_CORROBORATION,
} from "@/lib/fmv-confidence"

// ── All Day editions can be ask-corroborated, and the lane is what bounds it ──
//
// 🚨 WHY THIS EXISTS (2026-09-09, go-live M2). Ask-corroboration lifts LOW -> MEDIUM
// when an independent live ask agrees with the sales median. It was fed ONLY by Top
// Shot's `edition_offers.low_ask`, so NO All Day edition could ever be corroborated —
// 461 Top Shot editions hold MEDIUM on that path alone and All Day held zero. The
// stated reason was "All Day's ask is not in edition_offers": a data-availability
// fact, never a judgement that the All Day ask is weaker evidence.
//
// ⭐ THE STATE THAT LEFT BEHIND WAS INTERNALLY INCONSISTENT. The same
// `allday_edition_floor_ask.floor_ask` is already trusted, in the same route, to CAP
// a sales-derived FMV (it overrides the sales evidence) and to be the SOLE price
// signal for All Day's ASK_ONLY tier at floor x 0.90 (1,560 editions). An ask good
// enough to set a price alone cannot be too weak to merely AGREE with one.
//
// ⚠⚠ THE AGE SEMANTICS ARE THE WHOLE RISK, AND THEY DIFFER FROM TOP SHOT'S.
// Top Shot dates an ask by `edition_offers.updated_at` — a SWEEP time, "when we last
// re-confirmed this exists". All Day's ask comes from `cached_listings_v2`, which is
// EVENT-SOURCED: open means "the lane has not seen it end", and its `listed_at` is
// how long the thing has been ON SALE. Those are different contracts (the `*_at`
// name-is-not-its-contract trap): the median open All Day ask is 53 days old and
// perfectly live, so dating by `listed_at` would reject the population for no reason.
// What must be bounded is THE LANE — if the indexer dies, every open listing looks
// open forever, a failed read publishing itself as a fact.
//
// These tests pin the PROPERTIES, not the spellings: that All Day reaches
// corroboration at all; that a dead lane switches it off by itself; that an
// undatable lane withholds rather than assumes; and that none of it can move a
// published FMV value.

const ROUTE = path.join(path.resolve(__dirname, ".."), "app/api/fmv-recalc/route.ts")
const RAW = readFileSync(ROUTE, "utf8")
const SRC = stripComments(RAW)

// Sales clustered tightly at 100, thin enough to need corroboration (below the
// MEDIUM volume floor of 5) but at/above the corroboration floor of 3.
const THIN_TIGHT = [100, 100, 100]
const THIN_N = MIN_SALES_ASK_CORROBORATION

describe("the comment stripper actually stripped (a blind stripper fakes every check below)", () => {
  it("removed prose and kept code", () => {
    // Without BOTH halves, every source assertion in this file could be reading a
    // blanked file and reporting a clean pass.
    expect(
      RAW.toLowerCase(),
      "the sentinel prose is gone from the raw file — pick another",
    ).toContain("internally inconsistent")
    expect(SRC.toLowerCase()).not.toContain("internally inconsistent")
    expect(SRC, "the stripper blanked real source").toContain("escalateConfidence(")
  })
})

describe("All Day's floor ask reaches ask-corroboration", () => {
  it("is not vacuous: the route still reads the All Day floor and still calls the rule", () => {
    expect(SRC).toContain('.from("allday_edition_floor_ask")')
    expect(SRC).toContain("escalateConfidence(")
  })

  it("🚨 the All Day floor is merged into the CORROBORATION map, not only the ceiling", () => {
    // The defect this prevents is the original state: the floor reaching the
    // ask-CEILING (which lowers FMV) while corroboration stays Top-Shot-only, so
    // All Day can never earn MEDIUM. Keyed on the corroboration map receiving the
    // All Day floor map's values.
    expect(
      SRC,
      "the All Day floor no longer feeds editionAskById — All Day cannot be corroborated again",
    ).toMatch(/allDayFloorAskById\.entries\(\)[\s\S]{0,200}?editionAskById\.set\(/)
  })

  it("🚨 the ask and its age are written as a PAIR — an ask with no age reads as fresh", () => {
    // escalateConfidence treats `undefined` age as the legacy age-unaware path, which
    // corroborates REGARDLESS of age. So an entry added to editionAskById without a
    // matching editionAskAgeHoursById entry silently restores the unbounded behaviour
    // the 2026-08-29 age gate exists to prevent.
    const loop = SRC.match(/for \(const \[edId, ask\] of allDayFloorAskById\.entries\(\)\)[\s\S]*?\n      \}/)
    expect(loop, "the merge loop was renamed or removed — re-anchor this assertion").not.toBeNull()
    expect(loop![0]).toContain("editionAskById.set(")
    expect(loop![0], "the ask is merged without its age — undatable asks would corroborate").toContain(
      "editionAskAgeHoursById.set(",
    )
  })

  it("passes the age through to the rule, so the legacy unbounded path is not production", () => {
    expect(SRC).toContain("editionAskAgeHoursById.get(editionId) ?? null")
  })
})

describe("the LANE is what bounds the All Day ask, and a failed probe withholds", () => {
  it("🚨 the feed-liveness lag is never coalesced to a number", () => {
    // `?? 0` / `|| 0` on this value is the fabricated-number shape one level down: it
    // would publish "I could not read the lane" as "the lane is live right now", and
    // every All Day ask would corroborate off a failed read.
    expect(SRC).not.toMatch(/allDayFeedLagHours\s*(\?\?|\|\|)\s*0/)
    // ...and it must be able to BE null, or the three-state contract is decoration.
    expect(SRC).toMatch(/allDayFeedLagHours\s*:\s*number \| null/)
  })

  it("the liveness probe is bounded, so the honesty check cannot become a table scan", () => {
    const probe = SRC.match(/\.from\("cached_listings_v2"\)[\s\S]*?\.limit\(1\)/)
    expect(probe, "the All Day liveness probe lost its bound or its table").not.toBeNull()
  })

  it("reuses the ONE corroboration age constant — All Day must not grow its own threshold", () => {
    // Two thresholds answering the same question is how they drift apart.
    expect(SRC).not.toMatch(/ALLDAY_MAX_ASK_AGE|ALLDAY_ASK_STALE/)
  })
})

describe("CONTROL — corroboration can never move a published FMV value", () => {
  it("the ask-ceiling map is materialised BEFORE the corroboration merge", () => {
    // This ordering is the entire guarantee. The ceiling is a COPY of editionAskById;
    // if the All Day merge ran first, the merge would also change what caps FMV, and
    // a confidence change would silently become a PRICE change.
    const ceilingCopy = SRC.indexOf("new Map<string, number>(editionAskById)")
    const merge = SRC.search(/for \(const \[edId, ask\] of allDayFloorAskById\.entries\(\)\)/)
    expect(ceilingCopy, "the ceiling copy is gone — re-anchor this control").toBeGreaterThan(-1)
    expect(merge, "the corroboration merge is gone — re-anchor this control").toBeGreaterThan(-1)
    expect(
      ceilingCopy,
      "the corroboration merge now runs BEFORE the ceiling copy, so raising confidence can change a published price",
    ).toBeLessThan(merge)
  })
})

// The rule itself, exercised with All-Day-shaped inputs. These assert the behaviour
// the route's new feed-lag argument actually buys, so a change to either side shows up.
describe("the rule, given an All Day feed lag", () => {
  it("is not vacuous: a live lane corroborates a thin, agreeing All Day edition", () => {
    expect(escalateConfidence("LOW", THIN_N, THIN_TIGHT, undefined, 100, 0.05)).toBe("MEDIUM")
  })

  it("🚨 a DEAD lane withholds every lift — the indexer failing turns the feature off", () => {
    expect(
      escalateConfidence("LOW", THIN_N, THIN_TIGHT, undefined, 100, MAX_ASK_AGE_HOURS_CORROBORATION + 1),
      "a stale listings lane still lifted an edition to MEDIUM off asks nobody confirmed",
    ).toBe("LOW")
  })

  it("🚨 an UNREADABLE lane withholds too — 'I could not tell' is not 'live'", () => {
    expect(escalateConfidence("LOW", THIN_N, THIN_TIGHT, undefined, 100, null)).toBe("LOW")
  })

  it("CONTROL — a live lane whose ask DISAGREES with the median still stays LOW", () => {
    // The +/-25% band is the safety gate: 1,096 of the 1,545 LOW All Day editions with
    // a live ask do NOT agree and must not be lifted.
    expect(escalateConfidence("LOW", THIN_N, THIN_TIGHT, undefined, 220, 0.05)).toBe("LOW")
  })

  it("CONTROL — below the sales floor, a live agreeing ask is still not enough", () => {
    expect(
      escalateConfidence("LOW", MIN_SALES_ASK_CORROBORATION - 1, [100, 100], undefined, 100, 0.05),
    ).toBe("LOW")
  })

  it("CONTROL — the path only ever RAISES: a live ask never demotes a better tier", () => {
    // A no-change control the feature cannot move in the other direction.
    for (const lag of [0.05, MAX_ASK_AGE_HOURS_CORROBORATION + 1, null]) {
      expect(escalateConfidence("MEDIUM", THIN_N, THIN_TIGHT, undefined, 220, lag)).toBe("MEDIUM")
    }
  })
})
