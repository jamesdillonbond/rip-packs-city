// The Panini product pages (2026-10-25) are sitemap-advertised, read-only entity pages, so an anonymous
// visitor (and Googlebot) must reach them — the first deploy shipped them behind the sign-in wall
// (307 → /login on all three URLs below, read live 2026-10-25 ~7:40 PM PT). Pins the opening AND its edges.

import { describe, it, expect } from "vitest"
import { isPublicPath, isRateLimitedPageRoute } from "@/proxy"

describe("Panini product pages are anon-public", () => {
  it("the index and a product page are public for GET/HEAD", () => {
    for (const p of ["/panini-blockchain/product", "/panini-blockchain/product/", "/panini-blockchain/product/2026-panini-nft-prizm-world-cup-soccer"]) {
      expect(isPublicPath(p, "GET"), p).toBe(true)
      expect(isPublicPath(p, "HEAD"), p).toBe(true)
    }
  })
  it("a write method is not opened", () => {
    expect(isPublicPath("/panini-blockchain/product", "POST")).toBe(false)
  })
  it("a look-alike segment is not opened", () => {
    expect(isPublicPath("/panini-blockchain/productx", "GET")).toBe(false)
    expect(isPublicPath("/panini-blockchain/products", "GET")).toBe(false)
  })
  it("the product page is rate-limited like the other entity pages", () => {
    expect(isRateLimitedPageRoute("/panini-blockchain/product/x")).toBe(true)
  })
})
