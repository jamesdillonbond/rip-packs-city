// 2026-09-27 — a live sweep of the Disney Pinnacle tabs found another
// collection's vocabulary and features in Pinnacle's metadata and page copy:
// "moments", "players", badge detection, "liquid vs locked FMV", pull odds,
// and a five-collection list on a one-collection page. Pinnacle sells PINS by
// character / franchise / variant, has no badges and no lock UI.
import { describe, it, expect } from "vitest"
import { pageMetadata } from "@/lib/seo"
import { collectionHasBadges, collectionHasPage } from "@/lib/collections"

const PINNACLE_TABS = ["overview", "collection", "sniper", "packs", "sets", "analytics", "market"]
// Claims Pinnacle's pages cannot back. Word-boundary on "moment" so it cannot
// be satisfied by "momentum"-style words.
const FALSE_FOR_PINNACLE = [/\bmoments?\b/i, /\bplayers?\b/i, /\bbadge/i, /\blocked\b/i, /\bpull odds\b(?! are published)/i, /Top Shot/, /All Day/, /Golazos/, /UFC/]

describe("pageMetadata — Disney Pinnacle copy makes no claim the page cannot back", () => {
  for (const tab of PINNACLE_TABS) {
    it(`${tab}: no moments / players / badges / locking / other collections`, () => {
      const m = pageMetadata(tab, "Disney Pinnacle", "disney-pinnacle")
      const text = `${m.title} ${m.description}`
      for (const re of FALSE_FOR_PINNACLE) expect(text, `${tab} matched ${re}`).not.toMatch(re)
      expect(text).toMatch(/Disney Pinnacle/)
    })
  }
  it("packs states that no pull odds are published rather than offering them", () => {
    const m = pageMetadata("packs", "Disney Pinnacle", "disney-pinnacle")
    expect(String(m.description)).toMatch(/no per-tier pull odds are published/)
  })
  it("CONTROL: Top Shot keeps the shared template (the override is Pinnacle-only)", () => {
    const m = pageMetadata("analytics", "NBA Top Shot", "nba-top-shot")
    expect(String(m.description)).toMatch(/liquid vs locked FMV/)
  })
})

describe("registry switches", () => {
  it("Pinnacle has no badge program; Top Shot does", () => {
    expect(collectionHasBadges("disney-pinnacle")).toBe(false)
    expect(collectionHasBadges("nba-top-shot")).toBe(true)
  })
  it("only collections with a Pack Sniper tab get the Packs page's Pack Sniper link", () => {
    expect(collectionHasPage("disney-pinnacle", "pack-sniper")).toBe(false)
    expect(collectionHasPage("nba-top-shot", "pack-sniper")).toBe(true)
  })
})

describe("collectionEntityJsonLd — ItemList URLs are the pages the tiles link", () => {
  it("a Pinnacle pin's ListItem url is its own page, not the redirecting /edition/ URL", async () => {
    const { collectionEntityJsonLd } = await import("@/lib/seo")
    const ld = JSON.stringify(collectionEntityJsonLd({
      name: "Set", url: "https://www.rippackscity.com/disney-pinnacle/set/x", collectionUrlSlug: "disney-pinnacle",
      eds: [{ route_slug: "SEV1-MNF-DAIS-S1", player_name: "Daisy Duck" }], crumbName: "Sets",
    }))
    expect(ld).toContain("https://www.rippackscity.com/pinnacle/moment/SEV1-MNF-DAIS-S1")
    expect(ld).not.toContain("/disney-pinnacle/edition/")
  })
  it("CONTROL: Top Shot keeps its /edition/ URL", async () => {
    const { collectionEntityJsonLd } = await import("@/lib/seo")
    const ld = JSON.stringify(collectionEntityJsonLd({
      name: "Set", url: "https://www.rippackscity.com/nba-top-shot/set/x", collectionUrlSlug: "nba-top-shot",
      eds: [{ route_slug: "98:3150", player_name: "Damian Lillard" }], crumbName: "Sets",
    }))
    expect(ld).toContain("https://www.rippackscity.com/nba-top-shot/edition/98%3A3150")
  })
})

// 2026-09-28 — the Analytics FMV Health and Liquidity cards counted "editions"
// on every collection; Pinnacle prices each PIN. The noun is passed in.
describe("Analytics cards — the priced-row noun comes from the collection", () => {
  it("FmvHealthCard and LiquidityHeatmapCard render {countNoun}, never a hardcoded 'editions'", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("app/(collections)/[collection]/analytics/CollectionAnalyticsClient.tsx", "utf8")
    expect(src).not.toMatch(/toLocaleString\("en-US"\)\} editions/)
    expect(src).toMatch(/<FmvHealthCard short=\{short\} countNoun=\{pricedNoun\} \/>/)
    expect(src).toMatch(/<LiquidityHeatmapCard short=\{short\} countNoun=\{pricedNoun\} \/>/)
    expect(src).toMatch(/const pricedNoun = labels\.units === "Pins" \? "pins" : "editions"/)
  })
})

describe("Analytics KPI — Pinnacle counts pins", () => {
  it("the period KPI says Unique Pins on Pinnacle, Unique Editions elsewhere", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("app/(collections)/[collection]/analytics/CollectionAnalyticsClient.tsx", "utf8")
    expect(src).toMatch(/label=\{isPinnacle \? "Unique Pins" : "Unique Editions"\}/)
    expect(src).not.toMatch(/label="Unique Editions"/)
  })
})

// 2026-09-28 (#157): a Pinnacle sub-pool's detail page shows the PACK's EV.
describe("Pack detail page — Pinnacle drop-grain EV", () => {
  it("substitutes the drop EV, reports its read in the degraded notice, and never shows the pool's EV as the headline", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("app/(collections)/[collection]/pack/dist/[distId]/page.tsx", "utf8")
    expect(src).toMatch(/const pinDropRes = await fetchPinnacleDropEv\(collection, distId\)/)
    expect(src).toMatch(/const grossEv = usePinDrop\s*\?\s*num\(pinDrop!\.gross_ev\)/)
    expect(src).toMatch(/boardStatus\("Pack EV", pinDropRes\.ok\)/)
    expect(src).toMatch(/const grailPremiumComparable = !useCorrectedEv && !usePinDrop/)
    expect(src).toMatch(/const isSentinelEv = !usePinDrop && /)
  })
})
