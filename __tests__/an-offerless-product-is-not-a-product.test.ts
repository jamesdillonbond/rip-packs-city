// __tests__/an-offerless-product-is-not-a-product.test.ts
//
// Search Console 2026-10-20 → Product snippets: 5 INVALID items, all Panini
// edition pages whose JSON-LD typed the node `Product` with no offers/review/
// aggregateRating ("Either "offers", "review", or "aggregateRating" should be
// specified"). We withhold the Offer on purpose when there is no price we can
// stand behind, and must never fabricate a review or rating — so the node must
// stop CLAIMING to be a Product. lib/jsonld-product.ts; all four emitters.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { productOrCreativeWork } from "@/lib/jsonld-product"
import { editionJsonLd, packJsonLd } from "@/lib/seo"
import { buildMomentProductLd } from "@/lib/moment-detail-seo"

const graph0 = (ld: unknown) => (ld as { "@graph": Array<Record<string, unknown>> })["@graph"][0]

describe("an offer-less Product is not a Product", () => {
  it("helper: no offers → CreativeWork, Product-only keys dropped, the rest kept", () => {
    const out = productOrCreativeWork({ "@type": "Product", name: "N", url: "u", brand: { name: "B" }, sku: "s", category: "c", offers: undefined })
    expect(out["@type"]).toBe("CreativeWork")
    expect(out).not.toHaveProperty("brand")
    expect(out).not.toHaveProperty("sku")
    expect(out).not.toHaveProperty("category")
    expect(out).not.toHaveProperty("offers")
    expect(out).toMatchObject({ name: "N", url: "u" })
  })

  it("helper: a Product WITH an offer is untouched (mirror — must not strip valid snippets)", () => {
    const p = { "@type": "Product", name: "N", brand: { name: "B" }, offers: { "@type": "Offer", price: 1 } }
    expect(productOrCreativeWork(p)).toBe(p)
  })

  it("helper: non-Product nodes pass through", () => {
    const b = { "@type": "BreadcrumbList" }
    expect(productOrCreativeWork(b)).toBe(b)
  })

  it("editionJsonLd: Panini edition with no FMV and no ask → CreativeWork (the GSC case)", () => {
    const n = graph0(editionJsonLd({ route_slug: "packcard-1551_284633_7102066_19", player_name: "Allen Iverson", set_name: "Prizm" }, "panini-blockchain"))
    expect(n["@type"]).toBe("CreativeWork")
    expect(n.offers).toBeUndefined()
  })

  it("editionJsonLd: priced edition stays a Product with its Offer (mirror)", () => {
    const n = graph0(editionJsonLd({ route_slug: "x", player_name: "P", fmv: { fmv_usd: 10, confidence: "HIGH" } }, "panini-blockchain"))
    expect(n["@type"]).toBe("Product")
    expect(n.offers).toMatchObject({ "@type": "Offer", price: 10 })
  })

  it("packJsonLd: no retail price → CreativeWork; with price → Product", () => {
    expect(graph0(packJsonLd({ title: "T", collectionUrlSlug: "nba-top-shot", distId: "1" }))["@type"]).toBe("CreativeWork")
    expect(graph0(packJsonLd({ title: "T", collectionUrlSlug: "nba-top-shot", distId: "1", retailPriceUsd: 9 }))["@type"]).toBe("Product")
  })

  it("buildMomentProductLd: no price → CreativeWork; priced → Product", () => {
    const base = { subject: "S", serial: 1, mint: 10, setName: "Set", collectionDisplay: "NBA Top Shot", thumbnailUrl: null, sku: "k", fmvConfidence: "HIGH", fmvUsd: null, floorPriceUsd: null, topShotAsk: null, isListed: false, listPrice: null }
    expect(buildMomentProductLd(base)["@type"]).toBe("CreativeWork")
    expect(buildMomentProductLd({ ...base, fmvUsd: 5 })["@type"]).toBe("Product")
  })

  it("the Pinnacle pin page routes its Product through the helper (source pin)", () => {
    const src = readFileSync(join(__dirname, "..", "app/pinnacle/moment/[id]/page.tsx"), "utf8")
    expect(src).toMatch(/"@graph":\s*\[productOrCreativeWork\(product\)/)
  })
})
