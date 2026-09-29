import { describe, it, expect } from "vitest"
import { readSniperUrlFilters, sniperShareUrl } from "@/lib/sniper/helpers"

// 2026-09-29 — COPY LINK replaced SAVE SEARCH (which 400'd on every click). The
// link is the saved search, so what it writes must read back as the same board,
// and a hand-edited or stale link must never apply a value the page cannot show.

const allowed = { tiers: ["all", "COMMON", "RARE", "LEGENDARY"], sorts: ["listed_desc", "discount", "price_asc"] }
const base = { team: "all", player: "", tier: "all", maxPrice: 0, minDiscount: 0, sort: "listed_desc", defaultSort: "listed_desc" }

describe("sniperShareUrl / readSniperUrlFilters", () => {
  it("round-trips every filter", () => {
    const href = sniperShareUrl("https://www.rippackscity.com/nba-top-shot/sniper", {
      ...base, team: "Portland Trail Blazers", player: " Lillard ", tier: "RARE", maxPrice: 40, minDiscount: 15, sort: "discount",
    })
    expect(readSniperUrlFilters(new URL(href).searchParams, allowed)).toEqual({
      team: "Portland Trail Blazers", player: "Lillard", tier: "RARE", maxPrice: 40, minDiscount: 15, sort: "discount",
    })
  })

  it("an unfiltered board links as its plain URL (defaults are not written)", () => {
    expect(sniperShareUrl("https://x/nba-top-shot/sniper", base)).toBe("https://x/nba-top-shot/sniper")
  })

  it("keeps unrelated params, drops a one-off deep link, and replaces stale filter values", () => {
    const href = sniperShareUrl("https://x/nfl-all-day/sniper?section=moments&highlight=F1&moment=9&maxPrice=999", { ...base, maxPrice: 20 })
    const q = new URL(href).searchParams
    expect(q.get("section")).toBe("moments")
    expect(q.get("highlight")).toBeNull()
    expect(q.get("moment")).toBeNull()
    expect(q.getAll("maxPrice")).toEqual(["20"])
  })

  it("drops values the page cannot apply rather than seeding a filter that shows nothing", () => {
    const q = new URLSearchParams("tier=mythic&sort=bogus&maxPrice=-5&minDiscount=250&team=all&player=%20%20")
    expect(readSniperUrlFilters(q, allowed)).toEqual({})
  })

  it("matches a tier case-insensitively to the collection's own tab value", () => {
    expect(readSniperUrlFilters(new URLSearchParams("tier=rare"), allowed).tier).toBe("RARE")
  })

  it("no params → no filters", () => {
    expect(readSniperUrlFilters(null, allowed)).toEqual({})
    expect(readSniperUrlFilters(new URLSearchParams(""), allowed)).toEqual({})
  })
})
