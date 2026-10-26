// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

/**
 * Panini product page body (2026-10-25). Stated as the ABSENCE of the false claims: no FMV tier ever
 * appears; an unpriced remainder is said, never folded into the total; zero sales on record is "none on
 * record", never "no sales"; the sales lag is always disclosed; a failed read is "couldn't load", not a 404.
 */

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={href} {...rest}>{children}</a> }))

import PaniniProductBody, { PaniniProductUnavailable } from "@/components/entity/PaniniProductBody"
import { PaniniProductPacksSection } from "@/components/entity/PaniniEditionExtras"
import type { PaniniProduct } from "@/lib/panini/product"
import { paniniProductSlug, serialLabelOfSku, paniniProductHref } from "@/lib/panini/product-url"

afterEach(cleanup)

const P: PaniniProduct = {
  product_set_id: 2332,
  product_set_ids: [2332],
  name: "2026 Panini NFT Prizm World Cup Soccer",
  slug: "2026-panini-nft-prizm-world-cup-soccer",
  sport: "Soccer",
  editions: 5268,
  players: 659,
  sets: 62,
  priced_editions: 4760,
  fmv_total_usd: 491945,
  listed_editions: 4769,
  cheapest_ask_usd: 1,
  sales_30d: 1664,
  sales_30d_volume_usd: 128536,
  sales_30d_median_usd: 5,
  newest_sale_at: "2026-10-24T00:00:00Z",
  top_editions: [
    { external_id: "packcard-1", player_name: "Lionel Messi", parallel: "Gold", set_name: "Base", mint_cap: 10, thumbnail_url: null, fmv_usd: 65000, low_ask_usd: null },
    { external_id: "packcard-2", player_name: null, parallel: null, set_name: null, mint_cap: null, thumbnail_url: null, fmv_usd: 900, low_ask_usd: 1200 },
  ],
  top_sales_90d: [
    { external_id: "packcard-1", player_name: "Lionel Messi", parallel: "Gold", sku: "packcard-1__3_10", amount_usd: 25000, sold_at: "2026-09-01T00:00:00Z" },
    { external_id: "packcard-3", player_name: null, parallel: null, sku: "weird", amount_usd: 10, sold_at: "2026-09-02T00:00:00Z" },
  ],
  sets_list: [
    { slug: "base-prizms-blue", name: "Base Prizms Blue", editions: 499, listed: 484, fmv_total_usd: 6193.5, cheapest_ask_usd: 2 },
    { slug: "p1-x", name: null, editions: 1, listed: 0, fmv_total_usd: null, cheapest_ask_usd: null },
  ],
  computed_at: "2026-10-26T01:29:00Z",
}
const PACKS = { packs: [], productName: null }

describe("PaniniProductBody", () => {
  it("renders the headline, sets, editions and sales with their links", () => {
    const c = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} />).container
    expect(c.querySelector("h1")?.textContent).toBe(P.name)
    expect(c.textContent).toContain("5,268 editions seen")
    expect(c.querySelector('a[href="/panini-blockchain/set/base-prizms-blue"]')).not.toBeNull()
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-1"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="panini-product-top-sales"]')?.textContent).toContain("#3/10")
    expect(c.querySelector('[data-testid="panini-product-top-editions"]')?.textContent).toContain("not listed")
    expect(c.querySelector('[data-testid="panini-coverage-note"]')).not.toBeNull()
  })
  it("says how much of the catalogue the FMV total leaves out", () => {
    const c = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} />).container
    expect(c.textContent).toContain("508 unpriced")
  })
  it("always discloses the sales lag; zero is 'none on record', never 'no sales'", () => {
    const c = render(
      <PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={{ ...P, sales_30d: 0, newest_sale_at: null, top_sales_90d: [], top_editions: [], sets_list: [], priced_editions: P.editions }} packs={PACKS} />,
    ).container
    expect(c.querySelector('[data-testid="panini-product-sales-lag"]')?.textContent).toContain("not complete")
    expect(c.textContent).toContain("none on record yet")
    expect(c.textContent).not.toMatch(/\bno sales\b/i)
    expect(c.querySelector('[data-testid="panini-product-no-sales"]')).not.toBeNull()
    expect(c.textContent).toContain("5,268 editions priced")
  })
  it("never shows an FMV confidence tier", () => {
    const c = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} />).container
    expect(c.textContent).not.toMatch(/\b(HIGH|MEDIUM|LOW|ASK_ONLY)\b/)
  })
  it("a failed read is 'couldn't load', not a missing product", () => {
    const c = render(<PaniniProductUnavailable collection="panini-blockchain" />).container
    expect(c.textContent).toContain("does not mean the product is gone")
  })
})

describe("PaniniProductPacksSection modes", () => {
  const pack = { id: "1", title: "Hobby pack", productName: "WC", costUsd: null, costBasis: null, packsRemaining: 5, packsTotal: null, updatedAt: "2026-10-25T00:00:00Z", marketUrl: null }
  it("product mode: no per-card wording and no link back to itself", () => {
    const c = render(<PaniniProductPacksSection mode="product" collection="panini-blockchain" packs={{ packs: [pack], productName: "WC", stillInPacks: 3, fotlExclusive: false, productSetId: 2332 }} />).container
    expect(c.textContent).not.toContain("this card")
    expect(c.querySelector('[data-testid="panini-product-link"]')).toBeNull()
    expect(c.textContent).toContain("5 left")
    expect(c.textContent).toContain("no price")
  })
  it("product mode empty state names the product", () => {
    const c = render(<PaniniProductPacksSection mode="product" collection="panini-blockchain" packs={{ packs: [], productName: null, stillInPacks: null, fotlExclusive: false, productSetId: 1 }} />).container
    expect(c.textContent).toContain("RPC tracks no pack for this product.")
  })
  it("edition mode links the edition's product page", () => {
    const c = render(<PaniniProductPacksSection collection="panini-blockchain" packs={{ packs: [{ ...pack, packsRemaining: null, costUsd: 9, costBasis: "avg_sale" }], productName: "2026 Panini NFT Prizm WNBA", stillInPacks: null, fotlExclusive: false, productSetId: 2420 }} />).container
    expect(c.querySelector('[data-testid="panini-product-link"]')?.getAttribute("href")).toBe("/panini-blockchain/product/2026-panini-nft-prizm-wnba")
    expect(c.textContent).toContain("supply not published")
    expect(c.textContent).toContain("avg sale")
  })
  it("edition mode without a product name still links, generically", () => {
    const c = render(<PaniniProductPacksSection collection="panini-blockchain" packs={{ packs: [], productName: null, stillInPacks: null, fotlExclusive: false, productSetId: 7 }} />).container
    expect(c.querySelector('[data-testid="panini-product-link"]')?.textContent).toContain("All of this card's product")
  })
})

describe("product-url", () => {
  it("mirrors the SQL slug rule (one page per product name; an unnamed product keeps its id)", () => {
    expect(paniniProductSlug("2026 Panini NFT Prizm World Cup Soccer", 2332)).toBe("2026-panini-nft-prizm-world-cup-soccer")
    expect(paniniProductSlug("2023-24 Panini NFT Best of The NBA")).toBe("2023-24-panini-nft-best-of-the-nba")
    expect(paniniProductSlug(null, 1751)).toBe("panini-product-1751")
    expect(paniniProductSlug("Panini product 1751")).toBe("panini-product-1751")
    expect(paniniProductSlug("  !! ", 9)).toBe("panini-product-9")
    expect(paniniProductSlug(null)).toBeNull()
    expect(serialLabelOfSku("x__7_199")).toBe("#7/199")
    expect(serialLabelOfSku("x")).toBeNull()
    expect(paniniProductHref("panini-blockchain", "1-a")).toBe("/panini-blockchain/product/1-a")
  })
})
