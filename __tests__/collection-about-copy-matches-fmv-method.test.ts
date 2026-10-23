import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

/**
 * 2026-10-22: the overview About panels claimed FMV never uses asks ("never ask prices", "not ask
 * prices", "rather than what sellers are asking") for Top Shot, All Day and Candy — every one of
 * which prices an edition with no recent sales from its lowest live ask (ASK_ONLY, marked "from
 * asks", as /legal/fmv-methodology states) — and called Pinnacle's FMV "driven by ask-price
 * intelligence" when most priced pins are priced from sales. Stated as the ABSENCE of the false
 * claims, with a control that the methodology still describes the ask arm.
 */
const about = stripComments(readFileSync(join(process.cwd(), "app/(collections)/[collection]/overview/CollectionOverviewClient.tsx"), "utf8"))
const block = about.slice(about.indexOf("const COLLECTION_ABOUT"), about.indexOf("const TIER_COLORS"))
const method = readFileSync(join(process.cwd(), "app/legal/fmv-methodology/page.tsx"), "utf8")

describe("overview About copy agrees with the FMV method", () => {
  it("guards a real slice", () => {
    expect(block.length).toBeGreaterThan(2000)
    expect(block).not.toContain("TIER_COLORS")
    expect(block).toContain('"nfl-all-day"')
  })
  it("no collection claims FMV never comes from an ask", () => {
    for (const bad of [/never ask prices/i, /not ask prices/i, /not what sellers are asking/i, /rather than what sellers are asking/i, /ask-price intelligence/i]) {
      expect(block, String(bad)).not.toMatch(bad)
    }
  })
  it("the sales-first, ask-when-none rule is stated where the old claim was", () => {
    expect(block.match(/priced from its lowest live ask and marked as such/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
  it("CONTROL: the methodology page still describes pricing from a listing", () => {
    expect(method).toContain("Priced from a listing.")
  })
  it("no sniper promise of a primary market it does not read", () => {
    expect(block).not.toMatch(/pack-era primary market/i)
  })
})

// Same pass, the collection ticker (components/collection-chrome.tsx), rendered on every tab.
describe("collection ticker names each collection's real mechanism", () => {
  const chrome = stripComments(readFileSync(join(process.cwd(), "components/collection-chrome.tsx"), "utf8"))
  const pinnacle = chrome.slice(chrome.indexOf('"disney-pinnacle": ['), chrome.indexOf('"laliga-golazos": ['))
  it("Pinnacle's sniper is not described as relative deal scoring (that is Golazos's)", () => {
    expect(pinnacle.length).toBeGreaterThan(100)
    expect(pinnacle).not.toMatch(/relative deal scoring/i)
  })
  it("no ticker claims every edition is priced from sales alone, or that Golazos coverage is growing", () => {
    expect(chrome).not.toMatch(/every edition priced from real secondary sales/i)
    expect(chrome).not.toMatch(/COVERAGE — growing/)
  })
})
