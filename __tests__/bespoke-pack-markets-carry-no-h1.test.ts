import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-23 (served-HTML read): /panini-blockchain/packs and /candy-mlb/packs each shipped TWO <h1> — the collection
// banner's ("Panini Blockchain — Packs", components/CollectionHeading.tsx, which lists these Packs tabs as having no
// own h1) and the bespoke pack view's ("Panini — Pack Market"). The same views also mount inside the Market tab,
// whose page owns an h1. So the views carry an h2; the banner keeps the page h1 in every state (loading and failed
// included, where the view rendered no heading at all).
describe("bespoke pack market views carry no <h1>", () => {
  for (const f of ["components/packs/PaniniPackMarket.tsx", "components/packs/CandyPackMarket.tsx"]) {
    it(f, () => {
      const src = stripComments(readFileSync(join(process.cwd(), f), "utf8"))
      expect(src).not.toMatch(/<h1[\s>]/)
      expect(src).toMatch(/<h2[\s>]/)
    })
  }
  it("the banner still owns the Packs h1 for Panini and Candy", () => {
    const heading = readFileSync(join(process.cwd(), "components/CollectionHeading.tsx"), "utf8")
    expect(heading).toMatch(/"panini-blockchain": new Set\(\["packs"\]\)/)
    expect(heading).toMatch(/"candy-mlb": new Set\(\["packs"\]\)/)
  })
})
