import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  ASK_STALE_HOURS,
  askAgeHours,
  askAgeTitle,
  askStampKind,
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

  it("the tooltip REPORTS and never CONCLUDES, in every variant", () => {
    // ...and must NOT assert anything we did not check. "may already be sold" is a
    // possibility; "is sold" / "no longer listed" would be a claim about a listing
    // nobody has looked at, which is the defect this whole module exists to prevent.
    for (const kind of ["changed", "checked", "listed"] as const) {
      const t = askAgeTitle(30, kind)
      expect(t, kind).toMatch(/30h/)
      expect(t, kind).toMatch(/may already be sold/i)
      expect(t, kind).not.toMatch(/\bis sold\b/i)
      expect(t, kind).not.toMatch(/no longer listed/i)
      expect(t, kind).not.toMatch(/delisted/i)
    }
  })

  // 🚨 THE ASSERTION THAT WOULD HAVE CAUGHT THE 2026-08-28 REGRESSION, added
  // 2026-09-13. The old single sentence promised *"we last confirmed this ask Nh
  // ago; normally every edition is re-checked about hourly"*. When `offers-sweep`
  // died and the Atlas writer replaced it — bumping `updated_at` only when the
  // FLOOR CHANGES — both halves became false on Top Shot with nobody editing a
  // line of this file. A cadence promise is a claim about a LANE, and a lane can
  // die; so no variant may make one.
  it("no variant claims a re-check CADENCE — that claim is what went stale", () => {
    for (const kind of ["changed", "checked", "listed"] as const) {
      const t = askAgeTitle(30, kind)
      expect(t, kind).not.toMatch(/hourly|every hour|each hour|daily|continuously|constantly/i)
      // "normally …" is the shape the false promise took; ban the hedge outright.
      expect(t, kind).not.toMatch(/\bnormally\b/i)
    }
  })

  it("the three kinds say three DIFFERENT things — a shared sentence cannot be true of all", () => {
    const said = new Set([
      askAgeTitle(30, "changed"),
      askAgeTitle(30, "checked"),
      askAgeTitle(30, "listed"),
    ])
    expect(said.size).toBe(3)
    // And each says the thing its writer actually does.
    expect(askAgeTitle(30, "changed")).toMatch(/last changed/i)
    expect(askAgeTitle(30, "changed")).toMatch(/not when we last re-checked/i)
    expect(askAgeTitle(30, "checked")).toMatch(/last checked/i)
    expect(askAgeTitle(30, "listed")).toMatch(/posted/i)
  })
})

describe("askStampKind — which of the three a collection's ask timestamp IS", () => {
  it("maps each live collection to the meaning its WRITER gives the column", () => {
    // nba_top_shot: sync_edition_offers_from_atlas() bumps updated_at only under
    // `WHERE low_ask IS DISTINCT FROM EXCLUDED.low_ask` -> last CHANGED.
    expect(askStampKind("nba_top_shot")).toBe("changed")
    // disney_pinnacle: pinnacle_catalog_set_floor_asks() writes
    // floor_ask_updated_at on EVERY row every sweep -> last CHECKED.
    expect(askStampKind("disney_pinnacle")).toBe("checked")
    // nfl_all_day / laliga_golazos: cached_listings_v2.listed_at -> when the
    // SELLER posted it, over an index a row leaves when the listing closes.
    expect(askStampKind("nfl_all_day")).toBe("listed")
    expect(askStampKind("laliga_golazos")).toBe("listed")
  })

  it("accepts BOTH collection-string conventions — both are live in this codebase", () => {
    // The scanners' own payloads carry the hyphen form while the DB carries
    // underscores; a resolver that knew only one would silently fall through to
    // the default on half the call sites.
    expect(askStampKind("nba-top-shot")).toBe("changed")
    expect(askStampKind("nfl-all-day")).toBe("listed")
    expect(askStampKind("disney-pinnacle")).toBe("checked")
  })

  it("an unknown or missing slug falls back to the WEAKEST claim, not the friendliest", () => {
    // A new collection must not inherit a freshness promise nobody has checked
    // for it. "changed" is the only one of the three that promises no re-check.
    expect(askStampKind("some_new_collection")).toBe("changed")
    expect(askStampKind(null)).toBe("changed")
    expect(askStampKind(undefined)).toBe("changed")
    expect(askStampKind("")).toBe("changed")
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

// ── The edition page's "% below FMV" chip is dated by the same timestamp ────
//
// 🚨 `deal_pct` comes from `topshot_deals_vs_fmv`, whose `discount_pct` is
// `(fmv - edition_offers.low_ask) / fmv` — computed from THE SAME `edition_offers`
// row the page already holds as `highOffer`. On 2026-08-29 the chip asserted a flat
// "18% below FMV" while /insights/deals marked that identical row
// `⚠ ask unconfirmed 31h`: one product disagreeing with itself across a hyperlink.
//
// ⚠ A first read of this called the chip "structurally unqualifiable" because
// `get_edition_insight_links` returns no timestamp — which pointed at an RPC payload
// change. Reading the VIEW DEFINITION refuted that: it joins `edition_offers` on the
// same `(external_id, collection_id)`, so the timestamp was already in scope. A filed
// finding is a hypothesis; the cheap check beat the tidy story again.
describe("edition page dates its below-FMV chip from the ask it is derived from", () => {
  const src = readFileSync(
    path.join(path.resolve(__dirname, ".."), "app/(collections)/[collection]/edition/[slug]/page.tsx"),
    "utf8",
  )

  it("is not vacuous: the chip is still rendered from deal_pct", () => {
    expect(src).toContain("insightLinks.deal_pct != null")
    expect(src).toContain("% below FMV")
  })

  it("the chip is qualified by askAge, not left as a bare discount claim", () => {
    // Pinned as the PROPERTY — the chip's own JSX references the ask age — rather
    // than the exact caption, so a reword cannot slip past it.
    // ⚠ Anchor on the CHIP, not on the first mention: `insightLinks.deal_pct != null`
    // also appears in the `hasInsightLinks` section gate far above, and slicing from
    // there measured the wrong block entirely. Caught by writing the assertion first.
    // ⚠ ANCHOR ON THE RENDERED EXPRESSION, and both looser anchors were tried and
    // failed in the obvious ways this repo keeps recording:
    //   - `insightLinks.deal_pct != null` also appears in the `hasInsightLinks`
    //     SECTION GATE far above, so slicing from it measured the wrong block;
    //   - a bare `"% below FMV"` first matches the FIX'S OWN COMMENT, which quotes
    //     `"18% below FMV"` to explain what was wrong — a guard firing on the
    //     documentation of the bug it prevents, live, on the third attempt.
    // The interpolation below can only be the render.
    const at = src.indexOf("insightLinks.deal_pct)}% below FMV")
    expect(at, "the chip render moved; this guard is measuring nothing").toBeGreaterThan(0)
    const chipSrc = src.slice(at, at + 600)
    expect(chipSrc).toMatch(/askAge !== null && askAge >= ASK_STALE_HOURS/)
    expect(chipSrc).toMatch(/fmtAskAge\(askAge\)/)
  })
})
