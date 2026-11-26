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

describe("PaniniProductBody Top Players (2026-11-23)", () => {
  const players = [
    { player_name: "Lamine Yamal", editions: 35, priced_editions: 31, fmv_total_usd: 63923 },
    { player_name: "Unpriced Kid", editions: 2, priced_editions: 0, fmv_total_usd: null },
  ]
  it("lists each player with editions and FMV total, linked to the player page, and says how many are priced", () => {
    const c = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} topPlayers={{ ok: true, players }} />).container
    const sec = c.querySelector('[data-testid="panini-product-players"]')
    expect(sec?.textContent).toContain("35 editions · $63,923 (31 priced)")
    expect(c.querySelector('a[href="/panini-blockchain/player/lamine-yamal"]')).not.toBeNull()
  })
  it("an unpriced player reads 'no FMV yet', never $0", () => {
    const c = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} topPlayers={{ ok: true, players }} />).container
    const sec = c.querySelector('[data-testid="panini-product-players"]')?.textContent ?? ""
    expect(sec).toContain("2 editions · no FMV yet")
    expect(sec).not.toContain("$0")
  })
  it("a failed read says so; an empty list hides the section", () => {
    const failed = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} topPlayers={{ ok: false, players: [] }} />).container
    expect(failed.querySelector('[data-testid="panini-product-players-unavailable"]')).not.toBeNull()
    cleanup()
    const empty = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} topPlayers={{ ok: true, players: [] }} />).container
    expect(empty.textContent).not.toContain("Top Players in this Product")
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

describe("readPaniniProductTopPlayers", () => {
  const db = (res: { data: unknown; error: unknown }) => ({ rpc: () => Promise.resolve(res) })
  it("a failed read is ok:false, never an empty list", async () => {
    const { readPaniniProductTopPlayers } = await import("@/lib/panini/product")
    expect(await readPaniniProductTopPlayers("x", db({ data: null, error: { message: "timeout" } }))).toEqual({ ok: false, players: [] })
  })
  it("keeps a null FMV total null and drops unnamed rows", async () => {
    const { readPaniniProductTopPlayers } = await import("@/lib/panini/product")
    const r = await readPaniniProductTopPlayers("x", db({ data: [{ player_name: "A", editions: 2, priced_editions: 0, fmv_total_usd: null }, { player_name: "", editions: 1 }], error: null }))
    expect(r).toEqual({ ok: true, players: [{ player_name: "A", editions: 2, priced_editions: 0, fmv_total_usd: null }] })
  })
})

describe("PaniniProductMarketCapTile (2026-11-23)", () => {
  const cap = {
    editions: 5362, editions_with_cap_row: 5361, editions_supply_known: 5361, editions_priced: 5289,
    minted: 276186, minted_supply_known: 276180, burned: 11634, issuer_held: 27948, collector_held: 236604,
    mcap_usd: 5042419.63, mcap_minted_usd: 5690436.79, refreshed_at: "2026-11-24T02:41:00Z", stale: null,
  }
  it("shows the cap, says how many editions it leaves out, and claims no rank", () => {
    const c = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} marketCap={{ ok: true, cap }} />).container
    const tile = c.querySelector('[data-testid="panini-product-mcap"]')?.textContent ?? ""
    expect(tile).toContain("$5.04M")
    // 2026-11-25 re-pin: collector-held is set against the minted supply of the SAME supply-known editions
    expect(tile).toContain("of 276,180 minted on the 5,361 editions with a known split")
    expect(c.querySelector('[data-testid="panini-product-mcap-note"]')?.textContent).toContain("73 of 5,362 editions have no price yet")
    expect(tile).not.toMatch(/Rank|#\d/)
  })
  it("⚠ collector-held is never set against EVERY edition's minted supply (two populations understate the ratio)", () => {
    const partial = { ...cap, minted: 300000, minted_supply_known: 250000, editions_supply_known: 4000 }
    const t = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} marketCap={{ ok: true, cap: partial }} />).container.querySelector('[data-testid="panini-product-mcap"]')?.textContent ?? ""
    expect(t).toContain("of 250,000 minted on the 4,000 editions with a known split")
    expect(t).not.toContain("300,000 minted")
    cleanup()
    const full = { ...cap, editions_supply_known: cap.editions, minted_supply_known: cap.minted }
    const f = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} marketCap={{ ok: true, cap: full }} />).container.querySelector('[data-testid="panini-product-mcap"]')?.textContent ?? ""
    expect(f).toContain("of 276,186 minted")
    expect(f).not.toContain("editions with a known split")
  })
  it("an unknown cap is Unknown, never $0; a failed read says so; no row hides the tile", () => {
    const u = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} marketCap={{ ok: true, cap: { ...cap, mcap_usd: null, editions_priced: 0 } }} />).container
    expect(u.querySelector('[data-testid="panini-product-mcap"]')?.textContent).toContain("Unknown")
    expect(u.querySelector('[data-testid="panini-product-mcap"]')?.textContent).not.toContain("$0")
    cleanup()
    const f = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} marketCap={{ ok: false, cap: null }} />).container
    expect(f.querySelector('[data-testid="panini-product-mcap-unavailable"]')).not.toBeNull()
    cleanup()
    const n = render(<PaniniProductBody collection="panini-blockchain" collectionLabel="Panini" product={P} packs={PACKS} marketCap={{ ok: true, cap: null }} />).container
    expect(n.textContent).not.toContain("Market Cap")
  })
  it("readPaniniProductMarketCap: a failed read is ok:false; an old stamp is stale in PT", async () => {
    const { readPaniniProductMarketCap } = await import("@/lib/panini/product")
    const db = (res: { data: unknown; error: unknown }) => ({ rpc: () => Promise.resolve(res) })
    expect(await readPaniniProductMarketCap("x", db({ data: null, error: { message: "t" } }))).toEqual({ ok: false, cap: null })
    const r = await readPaniniProductMarketCap("x", db({ data: { ...cap, refreshed_at: "2026-11-20T02:41:00Z" }, error: null }), Date.parse("2026-11-24T03:00:00Z"))
    expect(r.cap?.stale).toMatch(/PT$/)
  })
})
