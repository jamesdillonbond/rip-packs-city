// 2026-11-26 (Trevor: "see how we can enable this for all collections"). /moment had the
// InteractiveSlab; the shared edition page (every collection's edition, and Panini's only
// detail page) and the Pinnacle pin page did not. Pins the slab onto both, and pins what the
// back may and may not carry: no FMV confidence (internal only), no "Moment" on a pin.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const EDITION = stripComments(readFileSync("app/(collections)/[collection]/edition/[slug]/page.tsx", "utf8"))
const PIN = stripComments(readFileSync("app/pinnacle/moment/[id]/page.tsx", "utf8"))

function slabBlock(src: string): string {
  const i = src.indexOf("<InteractiveSlab")
  const j = src.indexOf("</InteractiveSlab>", i)
  expect(i).toBeGreaterThan(-1)
  expect(j).toBeGreaterThan(i)
  return src.slice(i, j)
}

describe("the slab on every collection", () => {
  it("the shared edition page wraps its hero media in the slab", () => {
    const b = slabBlock(EDITION)
    expect(b).toContain("<MomentHeroMedia")
    expect(b).toMatch(/label: "Set"/)
    expect(b).toMatch(/label: "Minted"/)
  })
  it("the edition page asks the DB for stats and defaults the read to FAILED, not empty", () => {
    expect(EDITION).toMatch(/fetchSlabStats\(\{[^}]*date_from_db: true/)
    expect(EDITION).toMatch(/let slabStatsRes: SlabStatsRead = \{ ok: false/)
  })
  it("the edition back never shows FMV on a closed market", () => {
    expect(slabBlock(EDITION)).toMatch(/!marketClosed && fmv\?\.fmv_usd != null \? \{ label: "FMV"/)
  })
  it("the pin page wraps the pin art in the slab", () => {
    const b = slabBlock(PIN)
    expect(b).toContain("/api/public/pinnacle-image/")
    expect(b).toMatch(/label: "Variant"/)
    expect(b).toMatch(/label: "Minted"/)
  })
  it("neither back carries FMV confidence, and the pin back never says Moment", () => {
    for (const b of [slabBlock(EDITION), slabBlock(PIN)]) expect(b).not.toMatch(/confidence/i)
    expect(slabBlock(PIN)).not.toMatch(/Moment/)
  })
})
