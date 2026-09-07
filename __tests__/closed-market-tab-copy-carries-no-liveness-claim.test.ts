// A closed market's tab metadata must not advertise a live one.
//
// WHAT THIS PINS (filed 2026-09-06, Search Console read §2 + the CLAUDE.md
// honesty canon). `lib/seo.ts`'s PAGE_META is written for a LIVE market: "live
// FMV", "real-time FMV", "daily market pulse", "Live deals below FMV". UFC
// Strike's Flow market has not traded since 2026-05-13 (lib/market-closed.ts),
// and every one of its five published tabs was rendering that copy into
// <title>, <meta name="description">, og: and twitter: — including
// /ufc/overview, which is one of only six URLs on the site that earns search
// impressions at all. The sniper tab is the sharpest case: "Live deals below
// FMV" offers an ACTION the product cannot perform on a dead market.
//
// ⚠ THE PROPERTY, NOT THE SPELLING. This does not assert the new copy's words.
// It asserts, over the CROSS PRODUCT of every closed market in CLOSED_MARKETS
// and every tab in PUBLIC_TAB_PAGES:
//   1. the closure is DISCLOSED — the venue and the closure date both appear;
//   2. no liveness token survives anywhere in title or description;
//   3. no interpolation placeholder leaks through;
//   4. the copy actually DIFFERS from the live-market template for that tab
//      (without this the suite would pass on a no-op).
// A new tab added to PAGE_META with no closed-market counterpart falls straight
// through to the live template and fails (1), (2) and (4) here — which is the
// point: the record's completeness is the guard, not a convention.
//
// ⚠ NOT VACUOUS AT ZERO — the counts are asserted. If CLOSED_MARKETS empties
// (a market reopens) the population assertion fails loudly rather than the
// suite quietly checking nothing, which is how three earlier guards on this
// codebase died.

import { describe, it, expect } from "vitest"
import { CLOSED_MARKETS, closedMarket, formatClosedOn } from "@/lib/market-closed"
import { pageMetadata, PUBLIC_TAB_PAGES } from "@/lib/seo"
import { MARKET_LIVENESS_CLAIM } from "./helpers/market-liveness"

// Words that assert the market is trading right now. Checked case-insensitively
// on whole words, so "Live"/"live"/"LIVE" and "real-time" are all caught, while
// "delivery" or "alive" are not.
// ⚠ ONE shared pattern (helpers/market-liveness.ts), not a local copy. Three
// guards each declared their own on 2026-09-06 and they had already drifted;
// worse, the shared one's first version used `\bactive\b` and could not match
// "actively", so a positive control that SHOULD have failed passed. That
// pattern is pinned by its own test now.
const LIVENESS = MARKET_LIVENESS_CLAIM

function text(v: unknown): string {
  if (typeof v === "string") return v
  if (v && typeof v === "object" && "absolute" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>).absolute ?? "")
  }
  return String(v ?? "")
}

describe("closed-market tab metadata", () => {
  const closedSlugs = Object.keys(CLOSED_MARKETS)

  it("there is at least one closed market and at least one public tab to check", () => {
    // The population control. Everything below iterates these two sets; if
    // either is empty the assertions are satisfied by having nothing to test.
    expect(closedSlugs.length).toBeGreaterThan(0)
    expect(PUBLIC_TAB_PAGES.length).toBeGreaterThan(0)
  })

  it("every closed market × every public tab discloses the closure and claims no liveness", () => {
    let checked = 0
    for (const slug of closedSlugs) {
      const cm = closedMarket(slug)
      expect(cm).not.toBeNull()
      const venue = cm!.venue
      const closedOn = formatClosedOn(cm!.closedOn)

      for (const page of PUBLIC_TAB_PAGES) {
        const m = pageMetadata(page, "Test Collection", slug)
        const title = text(m.title)
        const description = text(m.description)
        const both = `${title} ${description}`
        const where = `${slug}/${page}`

        // (1) The closure is disclosed, with its venue and its date.
        expect(both, `${where}: no venue disclosure`).toContain(venue)
        expect(both, `${where}: no closure date`).toContain(closedOn)

        // (2) No liveness claim survives.
        expect(title, `${where}: liveness token in title`).not.toMatch(LIVENESS)
        expect(description, `${where}: liveness token in description`).not.toMatch(LIVENESS)

        // (3) No placeholder leaked.
        expect(both, `${where}: unfilled placeholder`).not.toMatch(/\{(label|venue|closedOn)\}/)

        // The og/twitter blocks are built from the same two strings, so they
        // inherit the property — assert it rather than assume it.
        expect(text((m.openGraph as Record<string, unknown> | undefined)?.description))
          .not.toMatch(LIVENESS)

        checked += 1
      }
    }
    // Ban at zero: the loop must have run the full cross product.
    expect(checked).toBe(closedSlugs.length * PUBLIC_TAB_PAGES.length)
  })

  it("a LIVE market keeps the live-market copy — the closed branch is not a global rewrite", () => {
    // The no-change control. If the closed-market branch fired for everyone,
    // the fix would read as working while having broken every live collection.
    const live = pageMetadata("overview", "NBA Top Shot", "nba-top-shot")
    expect(text(live.description)).toMatch(LIVENESS)
    expect(text(live.description)).not.toContain("market closed")

    // …and the two branches must actually differ, or this whole file is a no-op.
    for (const page of PUBLIC_TAB_PAGES) {
      const closed = pageMetadata(page, "X", closedSlugs[0]!)
      const open = pageMetadata(page, "X", "nba-top-shot")
      expect(text(closed.description), `${page}: closed copy equals live copy`)
        .not.toBe(text(open.description))
    }
  })
})

// ── The entity-detail helpers ───────────────────────────────────────────────
//
// 🚨 ADDED 2026-09-06 BECAUSE THE GUARD ABOVE HAD A BLIND SPOT AND A REAL DEFECT
// LIVED IN IT. Everything above walks `pageMetadata`, i.e. the TAB copy. The
// five entity-detail helpers build their own descriptions, and
// `editionPageMetadata` appended an unconditional tail — so a closed-market
// edition read:
//
//   "…before its Flow market closed on 13 May 2026. Historical value, not a
//    present-day price. Tier CONTENDER. Circulation 23,970. LIVE FMV, recent
//    sales, history chart, and packs that contained this edition."
//
// contradicting itself inside one sentence run, on every UFC edition page —
// the largest URL family this collection has. ⚠ It was found by READING A LIVE
// PAGE, not by grepping: the same file branches correctly on isMarketClosed()
// for the identical string in `editionJsonLd`, twenty lines below, so a source
// search for the bug pattern would have landed on the version that was right.
//
// ⭐ SO THIS WALKS ALL FIVE HELPERS, not the one that was broken. Pinning
// `editionPageMetadata` alone would have re-created the blind spot one level
// down. ⓘ Measured at the time: set / player / team / series were already
// clean (they route FMV through fmvClosedQualifier), so this was one defect,
// not five — the guard exists to keep it that way.

import {
  editionPageMetadata,
  setPageMetadata,
  playerPageMetadata,
  teamPageMetadata,
  seriesPageMetadata,
} from "@/lib/seo"

describe("closed-market entity-detail metadata", () => {
  const closedSlugs = Object.keys(CLOSED_MARKETS)

  // Each helper with a payload rich enough to exercise every branch that could
  // append a liveness claim — an FMV present AND absent, since the edition bug
  // lived in a part of the string that fired either way.
  const helpers = (slug: string) => [
    ["edition (priced)", editionPageMetadata({ route_slug: "x", player_name: "P", set_name: "S", tier: "T", series_label: "1", circulation_count: 23970, fmv: { fmv_usd: 12 } }, slug)],
    ["edition (unpriced)", editionPageMetadata({ route_slug: "x", player_name: "P", set_name: "S" }, slug)],
    ["set", setPageMetadata({ set_name: "S", edition_count: 3, total_circulation: 100, fmv_total_usd: 99 }, slug, "s")],
    ["player", playerPageMetadata({ name: "P", team: "T", edition_count: 3, fmv_total_usd: 99 }, slug, "p")],
    ["team", teamPageMetadata({ team_name: "T", player_count: 2, edition_count: 3, fmv_total_usd: 99 }, slug, "t")],
    ["series", seriesPageMetadata({ display_label: "Series 1", edition_count: 3, set_count: 2, fmv_total_usd: 99 }, slug, "1")],
  ] as const

  it("has helpers and closed markets to check (population control)", () => {
    expect(closedSlugs.length).toBeGreaterThan(0)
    expect(helpers(closedSlugs[0]!).length).toBe(6)
  })

  it("no closed-market entity description makes a liveness claim", () => {
    let checked = 0
    for (const slug of closedSlugs) {
      for (const [name, m] of helpers(slug)) {
        const desc = String(m.description ?? "")
        expect(desc.length, `${slug}/${name}: empty description`).toBeGreaterThan(20)
        expect(desc, `${slug}/${name}: "${desc}"`).not.toMatch(LIVENESS)
        checked += 1
      }
    }
    expect(checked).toBe(closedSlugs.length * 6)
  })

  it("…and every one still DISCLOSES the closure, so silence is not how they pass", () => {
    // Without this, deleting the FMV sentence entirely would satisfy the case
    // above — a description that says nothing claims nothing.
    for (const slug of closedSlugs) {
      const cm = closedMarket(slug)!
      for (const [name, m] of helpers(slug)) {
        const desc = String(m.description ?? "")
        expect(desc, `${slug}/${name} does not name the closure`).toContain(formatClosedOn(cm.closedOn))
      }
    }
  })

  it("NO-CHANGE CONTROL — a live market keeps its liveness copy", () => {
    // A fix that stripped the tail for everyone would satisfy both cases above
    // while flattening the description on ~23K live entity pages.
    const live = editionPageMetadata({ route_slug: "x", player_name: "P", set_name: "S" }, "nba-top-shot")
    expect(String(live.description)).toMatch(LIVENESS)
    expect(String(live.description)).toContain("Live FMV")
  })
})
