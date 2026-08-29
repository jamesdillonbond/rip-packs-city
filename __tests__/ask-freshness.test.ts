import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  ASK_STALE_HOURS,
  askAgeHours,
  askAgeTitle,
  askVerifiedAt,
  fmtAskAge,
  isAskStale,
} from "@/lib/market/ask-freshness"

// ⚠ WHY THIS EXISTS (2026-08-29). `edition_offers` has ONE writer for the ask side —
// the `offers-sweep` cron — and when its upstream died the whole column froze: 12,259
// Top Shot asks at a MEDIAN age of 30.0 h, p90 30.3 h, 150 of 12,259 refreshed in
// twelve hours. Three surfaces rendered those numbers as current. The rendering fixes
// live with their components; the RULES live here, once, because CLAUDE.md's standing
// instruction for this class is *grep for the EXPRESSION, not the file — it has spread
// by copy-paste five times now.*

const HOUR = 3_600_000
const T0 = Date.parse("2026-08-29T22:00:00.000Z")

describe("ask freshness — three states, never two", () => {
  it("a known age is returned in hours", () => {
    expect(askAgeHours(new Date(T0 - 30 * HOUR).toISOString(), T0)).toBeCloseTo(30, 6)
  })

  it("🚨 an UNKNOWN age is null, and null must never be mistaken for fresh", () => {
    // The three inputs that mean "we cannot know": no timestamp, an unparseable
    // one, and a client that has not mounted and so has no clock. All three must
    // land in the SAME bucket, and it must not be the stale bucket either —
    // inventing "30h" for a row we never timed is a fabricated measurement.
    expect(askAgeHours(null, T0)).toBeNull()
    expect(askAgeHours(undefined, T0)).toBeNull()
    expect(askAgeHours("not-a-date", T0)).toBeNull()
    expect(askAgeHours(new Date(T0).toISOString(), null)).toBeNull()
    // ...and none of them is stale, which is what callers branch on.
    expect(isAskStale(null, T0)).toBe(false)
    expect(isAskStale("not-a-date", T0)).toBe(false)
    expect(isAskStale(new Date(T0 - 99 * HOUR).toISOString(), null)).toBe(false)
  })

  it("the threshold is inclusive at the boundary and quiet below it", () => {
    const at = (h: number) => new Date(T0 - h * HOUR).toISOString()
    expect(isAskStale(at(ASK_STALE_HOURS), T0)).toBe(true)
    expect(isAskStale(at(ASK_STALE_HOURS - 0.5), T0)).toBe(false)
    expect(isAskStale(at(ASK_STALE_HOURS + 0.5), T0)).toBe(true)
  })

  it("the threshold sits FAR above the healthy cadence, not beside it", () => {
    // A healthy offers-sweep wraps the whole catalogue 8-18 times a day, so a fresh
    // ask is minutes-to-an-hour old. If this constant ever drifts down near that,
    // the marker starts firing on ordinary jitter and stops meaning anything.
    expect(ASK_STALE_HOURS).toBeGreaterThanOrEqual(6)
    expect(ASK_STALE_HOURS).toBeLessThanOrEqual(24)
  })

  it("formats compactly and switches to days past 48h", () => {
    expect(fmtAskAge(30)).toBe("30h")
    expect(fmtAskAge(47.4)).toBe("47h")
    expect(fmtAskAge(72)).toBe("3d")
  })

  it("the tooltip REPORTS and never CONCLUDES", () => {
    const t = askAgeTitle(30)
    // It must say when we last looked...
    expect(t).toMatch(/last confirmed this ask 30h ago/i)
    // ...and must NOT assert anything we did not check. "may already be sold" is a
    // possibility; "is sold" / "no longer listed" would be a claim about a listing
    // nobody has looked at, which is the defect this whole module exists to prevent.
    expect(t).toMatch(/may already be sold/i)
    expect(t).not.toMatch(/\bis sold\b/i)
    expect(t).not.toMatch(/no longer listed/i)
    expect(t).not.toMatch(/delisted/i)
  })
})

describe("ask provenance — a timestamp only stamps the value it describes", () => {
  it("returns the offers timestamp when the offers row IS the source", () => {
    expect(askVerifiedAt({ low_ask: 150, updated_at: "2026-08-28T16:00:00.000Z" }))
      .toBe("2026-08-28T16:00:00.000Z")
  })

  it("🚨 returns null when there is no low_ask — the rendered number came from ELSEWHERE", () => {
    // This is the case the function exists for. The edition page resolves
    // `highOffer.low_ask ?? fmv.cross_market_ask`, so when the first link is null the
    // number on screen is the FMV fallback — and `updated_at` (which is present, and
    // real, and describes the OFFER side) would attach a precise, wrong age to it.
    expect(askVerifiedAt({ low_ask: null, updated_at: "2026-08-28T16:00:00.000Z" })).toBeNull()
    expect(askVerifiedAt({ updated_at: "2026-08-28T16:00:00.000Z" })).toBeNull()
  })

  it("CONTROL — a present low_ask with no timestamp is null, not a fabricated one", () => {
    expect(askVerifiedAt({ low_ask: 150, updated_at: null })).toBeNull()
    expect(askVerifiedAt({ low_ask: 150 })).toBeNull()
  })

  it("CONTROL — a missing row is null and does not throw", () => {
    expect(askVerifiedAt(null)).toBeNull()
    expect(askVerifiedAt(undefined)).toBeNull()
  })

  it("a zero ask still counts as a source (0 is a value, not an absence)", () => {
    // `== null` not `!`: a $0 ask is a real reading and its age is knowable. Using a
    // falsy check here would silently drop the marker on exactly the rows most worth
    // questioning.
    expect(askVerifiedAt({ low_ask: 0, updated_at: "2026-08-28T16:00:00.000Z" }))
      .toBe("2026-08-28T16:00:00.000Z")
  })
})

// ── The edition page must actually USE the provenance helper ────────────────
// The unit tests above prove the rule; this proves the highest-traffic surface is
// wired to it. Asserted structurally rather than by rendering, because the page is a
// server component with a deep data-fetch graph — but it asserts the PROPERTY (the
// displayed ask is stamped only via the helper), not a spelling of the markup.
describe("edition page is wired to the provenance helper", () => {
  const src = readFileSync(
    path.join(path.resolve(__dirname, ".."), "app/(collections)/[collection]/edition/[slug]/page.tsx"),
    "utf8",
  )

  it("is not vacuous: the ask cell and its fallback chain are still there", () => {
    expect(src).toContain("const askValue = highOffer?.low_ask ?? fmv?.cross_market_ask")
    expect(src).toContain("label={askLabel}")
  })

  it("derives the ask age through askVerifiedAt, never from highOffer.updated_at directly", () => {
    expect(src).toContain("askVerifiedAt(highOffer)")
    // The banned shape: reaching past the helper to the raw timestamp for the ASK.
    // (The BEST-OFFER cell legitimately uses highOffer.updated_at — that timestamp
    // does describe the offer — so this pins the ask-age derivation specifically.)
    expect(src).not.toMatch(/askAgeHours\(\s*highOffer/)
  })
})
