import { describe, it, expect } from "vitest"
import {
  createSourceFailureSink,
  sniperFeedDegraded,
  sniperEmptyCopy,
  SNIPER_DEGRADED_EMPTY_COPY,
  SNIPER_DEGRADED_EMPTY_HEADING,
} from "@/lib/sniper/source-failures"

// The sniper feed's deal-bearing reads each collapsed to an empty list on
// failure, so the route answered 200 with `deals: []` and the board printed
// "No deals match your filters. Try widening your search." — a conclusion drawn
// from a read that never happened, and the ACTIONABLE sub-class of it: it sends
// the reader to widen filters that were never the reason.
//
// These pin the primitive. The route- and client-level pins live in
// api-sniper-feed-degraded-sources.test.ts and
// sniper-empty-state-does-not-conclude-from-a-failed-read.test.tsx.

describe("createSourceFailureSink", () => {
  it("starts clean, so a healthy build is NOT reported as degraded", () => {
    const sink = createSourceFailureSink()
    expect(sink.failed).toEqual([])
    expect(sniperFeedDegraded(sink.failed)).toBe(false)
  })

  it("records a noted source", () => {
    const sink = createSourceFailureSink()
    sink.note("ts_listings")
    expect(sink.failed).toEqual(["ts_listings"])
    expect(sniperFeedDegraded(sink.failed)).toBe(true)
  })

  it("dedupes — the All Day pool notes the same source once per page", () => {
    const sink = createSourceFailureSink()
    sink.note("allday-marketplace")
    sink.note("allday-marketplace")
    expect(sink.failed).toEqual(["allday-marketplace"])
  })

  it("keeps first-seen order across distinct sources", () => {
    const sink = createSourceFailureSink()
    sink.note("ts_listings")
    sink.note("topshot-deals-rpc")
    expect(sink.failed).toEqual(["ts_listings", "topshot-deals-rpc"])
  })

  it("ignores an empty label rather than reporting a nameless failure", () => {
    const sink = createSourceFailureSink()
    sink.note("")
    expect(sink.failed).toEqual([])
    expect(sniperFeedDegraded(sink.failed)).toBe(false)
  })

  // ⚠ The reason this is an argument-threaded sink and not a module-level one:
  // the route caches per-param inside a WARM lambda, so a shared accumulator
  // would publish one reader's outage in another reader's response.
  it("two sinks are independent — one request's failure cannot leak into another's", () => {
    const a = createSourceFailureSink()
    const b = createSourceFailureSink()
    a.note("allday-marketplace")
    expect(b.failed).toEqual([])
    expect(sniperFeedDegraded(b.failed)).toBe(false)
  })
})

describe("sniperFeedDegraded", () => {
  it("treats an absent field as NOT degraded (a caller that predates the field)", () => {
    expect(sniperFeedDegraded(undefined)).toBe(false)
    expect(sniperFeedDegraded(null)).toBe(false)
  })

  it("is false on an empty list — an empty board with every source answering is honestly empty", () => {
    expect(sniperFeedDegraded([])).toBe(false)
  })

  it("is true on any non-empty list", () => {
    expect(sniperFeedDegraded(["allday-fmv"])).toBe(true)
  })
})

describe("sniperEmptyCopy", () => {
  const QUIET = "No deals match your filters. Try widening your search."

  it("returns the genuine empty line when every source answered", () => {
    expect(sniperEmptyCopy([], QUIET)).toBe(QUIET)
    expect(sniperEmptyCopy(undefined, QUIET)).toBe(QUIET)
  })

  it("does NOT publish the filter diagnosis when a source failed", () => {
    const copy = sniperEmptyCopy(["ts_listings"], QUIET)
    expect(copy).not.toBe(QUIET)
    expect(copy).not.toMatch(/widening/i)
    expect(copy).not.toMatch(/your filters/i)
  })

  it("reports the failed read rather than concluding about supply", () => {
    const copy = sniperEmptyCopy(["ts_listings"], QUIET)
    expect(copy).toBe(SNIPER_DEGRADED_EMPTY_COPY)
    expect(copy).toMatch(/couldn't reach/i)
    // "there are no deals" / "the floor is quiet" are claims about the market.
    expect(copy).not.toMatch(/\bno deals\b/i)
    expect(copy).not.toMatch(/\bquiet\b/i)
  })

  it("the degraded heading makes no claim about supply either", () => {
    expect(SNIPER_DEGRADED_EMPTY_HEADING).not.toMatch(/quiet/i)
    expect(SNIPER_DEGRADED_EMPTY_HEADING).not.toMatch(/no deals/i)
  })

  it("keeps internal source labels out of user-facing copy", () => {
    const copy = sniperEmptyCopy(["ts_listings", "allday-marketplace", "topshot-deals-rpc"], QUIET)
    expect(copy).not.toMatch(/ts_listings|allday-marketplace|topshot-deals-rpc/)
  })
})
