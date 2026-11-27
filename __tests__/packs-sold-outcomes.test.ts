import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  parseSoldPackIds, soldContainerLabel, soldOpenerLabel, soldOutcomeIsHit, soldOutcomeValueLabel, soldOutcomeVsSaleLabel, soldPullLabel,
  type SoldPackOutcome,
} from "@/lib/packs-sold-outcomes"

// 2026-11-27 (Trevor: "see if any of the packs I sold had something good"). The binder's Sold tab
// shows what the next owner pulled. These pin the three honest states, the never-an-address rule,
// and the route's gate.

const base: SoldPackOutcome = {
  pack_nft_id: "256186211873169",
  sold_at: "2026-07-31T00:05:00Z",
  sale_price: 215,
  opened: true,
  opened_at: "2026-07-31T00:11:01Z",
  opener_is_you: false,
  opener_username: "ZR_711",
  moments_pulled: 5,
  pulls_named: 5,
  pulls_priced: 5,
  pull_value_usd: 256.05,
  pulls: [
    { nft_id: "51493881", edition_id: "e1", player_name: "LeBron James", set_name: "Holo Icon", tier: "LEGENDARY", serial_number: 14, circulation_count: 39, fmv_usd: 241.37 },
  ],
}

describe("sold pack outcome labels", () => {
  it("a fully valued opened pack shows its total and flags a hit over the sale price", () => {
    expect(soldOutcomeValueLabel(base)).toBe("$256.05")
    expect(soldOutcomeIsHit(base)).toBe(true)
    expect(soldOutcomeVsSaleLabel(base)).toBe("$41.05 more than you sold it for")
  })
  it("a sealed pack says so and is never a hit", () => {
    const o = { ...base, opened: false, opened_at: null, opener_username: null, moments_pulled: null, pulls_named: 0, pulls_priced: 0, pull_value_usd: null, pulls: [] }
    expect(soldOutcomeValueLabel(o)).toBe("Not opened yet")
    expect(soldOutcomeIsHit(o)).toBe(false)
  })
  it("a partly priced pack says how far it got and never publishes a partial sum", () => {
    const o = { ...base, pulls_priced: 3, pull_value_usd: null }
    expect(soldOutcomeValueLabel(o)).toBe("3 of 5 priced")
    expect(soldOutcomeValueLabel(o)).not.toMatch(/\$/)
    expect(soldOutcomeIsHit(o)).toBe(false)
    expect(soldOutcomeVsSaleLabel(o)).toBeNull()
  })
  it("names the opener by username, as You, or as another collector -- never by address", () => {
    expect(soldOpenerLabel(base)).toBe("@ZR_711")
    expect(soldOpenerLabel({ ...base, opener_is_you: true, opener_username: null })).toBe("You")
    expect(soldOpenerLabel({ ...base, opener_username: null })).toBe("Another collector")
  })
  it("labels a pull with tier and serial / mint size", () => {
    expect(soldPullLabel(base.pulls[0])).toBe("LeBron James · Legendary #14/39")
    expect(soldPullLabel({ ...base.pulls[0], player_name: null, tier: null, serial_number: null })).toBe("Unnamed Moment")
  })

  it("names a parallel pull, and never tags the Standard printing", () => {
    expect(soldPullLabel({ ...base.pulls[0], parallel: "Hexwave" })).toBe("LeBron James · Legendary Hexwave #14/39")
    expect(soldPullLabel({ ...base.pulls[0], parallel: "Standard" })).toBe("LeBron James · Legendary #14/39")
    expect(soldPullLabel({ ...base.pulls[0], parallel: null })).toBe("LeBron James · Legendary #14/39")
  })
})

describe("boxes, cases and opens with nothing on record (v2)", () => {
  it("an index-confirmed open with nothing on record says so -- never 'Not opened yet', never a total", () => {
    const o = { ...base, opened_at: null, opener_username: null, moments_pulled: null, pulls_named: 0, pulls_priced: 0,
      pull_value_usd: null, pulls: [], contents_unknown: true }
    expect(soldOutcomeValueLabel(o)).toBe("Opened · contents not on record")
    expect(soldOutcomeValueLabel(o)).not.toMatch(/Not opened/)
    expect(soldOutcomeIsHit(o)).toBe(false)
  })
  it("a box whose open is unknown never reads as 'Not opened yet'", () => {
    const o = { ...base, opened: false, opened_at: null, opener_username: null, moments_pulled: null, pulls_named: 0,
      pulls_priced: 0, pull_value_usd: null, pulls: [], open_status_unknown: true }
    expect(soldOutcomeValueLabel(o)).toBe("Open status unknown")
  })
  it("a box with unopened inner packs says how many are opened, and names its packs", () => {
    const o = { ...base, is_container: true, packs_inside: 8, packs_opened: 5, pull_value_usd: null }
    expect(soldOutcomeValueLabel(o)).toBe("5 of 8 packs opened")
    expect(soldContainerLabel(o)).toBe("8 packs inside")
    expect(soldContainerLabel(base)).toBeNull()
  })
  it("a fully opened, fully priced box shows its total like a pack", () => {
    const o = { ...base, is_container: true, packs_inside: 8, packs_opened: 8, pull_value_usd: 117.76 }
    expect(soldOutcomeValueLabel(o)).toBe("$117.76")
  })
})

describe("parseSoldPackIds", () => {
  it("accepts numeric ids, dedupes, and refuses anything else", () => {
    expect(parseSoldPackIds(null)).toEqual([])
    expect(parseSoldPackIds("1,2,2")).toEqual(["1", "2"])
    expect(parseSoldPackIds("1,abc")).toBeNull()
    expect(parseSoldPackIds("1;drop table")).toBeNull()
    expect(parseSoldPackIds(Array.from({ length: 101 }, (_, i) => String(i + 1)).join(","))).toBeNull()
  })
})

describe("/api/wallet/sold-pack-outcomes gate", () => {
  const src = readFileSync(join(process.cwd(), "app/api/wallet/sold-pack-outcomes/route.ts"), "utf8")
  it("requires a signed-in user and the wallet saved on that account", () => {
    expect(src).toContain("requireUser()")
    expect(src).toContain('.from("saved_wallets")')
    expect(src).toMatch(/\.eq\(\s*["']user_id["']\s*,\s*user\.id\s*\)/)
    expect(src).toMatch(/\.eq\(\s*["']wallet_addr["']\s*,\s*wallet\s*\)/)
  })
  it("answers a failed read with apiErrorResponse, never an empty list", () => {
    expect(src).toMatch(/if \(error\)[\s\S]{0,120}apiErrorResponse/)
  })
})
