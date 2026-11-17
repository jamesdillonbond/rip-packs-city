import { describe, it, expect } from "vitest"
import { packDistributionIsSitemapWorthy } from "@/lib/sitemap-data"

// 2026-11-06 audit: /disney-pinnacle/pack/dist/0 "[OLD] Summer Splash",
// /disney-pinnacle/pack/dist/8906 "Internal Test" and All Day's "Distribution
// Mock Test" were sitemap-listed. The issuer's own label says these are not
// products; the mint count cannot (0 is "unknown" — every Golazos row is 0).
describe("packDistributionIsSitemapWorthy — issuer-labelled non-products", () => {
  it("omits [OLD], Internal Test and Mock Test distributions", () => {
    expect(packDistributionIsSitemapWorthy({ title: "[OLD] Summer Splash - Premium Distribution", total_minted: 0 })).toBe(false)
    expect(packDistributionIsSitemapWorthy({ title: "Internal Test", total_minted: 0 })).toBe(false)
    expect(packDistributionIsSitemapWorthy({ title: "Distribution Mock Test", total_minted: 0 })).toBe(false)
  })
  it("keeps real products — 0 minted stays unknown, and 'test' inside a real name is not a label", () => {
    expect(packDistributionIsSitemapWorthy({ title: "World Stars", total_minted: 0 })).toBe(true)
    expect(packDistributionIsSitemapWorthy({ title: "2025-26 NBA Playoffs Mega Box", total_minted: 0 })).toBe(true)
    expect(packDistributionIsSitemapWorthy({ title: "Greatest Hits: The Test of Time", total_minted: 500 })).toBe(true)
    expect(packDistributionIsSitemapWorthy({ title: "Old School Legends", total_minted: 500 })).toBe(true)
  })
})

import { readFileSync } from "fs"
describe("the pack dist page applies the same label test", () => {
  it("noindexes an issuer-labelled non-product (the sitemap omission alone leaves the page indexable via links)", () => {
    const src = readFileSync("app/(collections)/[collection]/pack/dist/[distId]/page.tsx", "utf8")
    expect(src).toMatch(/SITEMAP_PACK_NON_PRODUCT_TITLE\.test\(title\)\s*\?\s*\{\s*robots:\s*\{\s*index:\s*false/)
  })
})
