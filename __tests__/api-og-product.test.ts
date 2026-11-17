import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * /api/og/product — the Panini product page's branded card (2026-10-26).
 * A failed read is readFailed (short cache, no claim); an unknown slug is a plain card,
 * never "0 editions"; the stat is labelled as sales ON RECORD; no confidence anywhere.
 */
const rendered: Record<string, unknown>[] = []
vi.mock("@/lib/og/entity-card", () => ({ renderEntityOg: (o: Record<string, unknown>) => { rendered.push(o); return new Response("png") } }))
const state: { res: unknown; throws: boolean } = { res: null, throws: false }
vi.mock("@/lib/panini/product", () => ({
  readPaniniProduct: async () => { if (state.throws) throw new Error("boom"); return state.res },
}))

import { GET } from "@/app/api/og/product/route"
const req = (qs: string) => ({ nextUrl: new URL("https://t/api/og/product" + qs) }) as any
const PRODUCT = {
  name: "2025-26 Panini NFT Prizm WNBA", slug: "2420-prizm-wnba", sport: "Womens Basketball", editions: 3719, sets: 40,
  sales_30d_volume_usd: 12345.6, fmv_total_usd: 999, fmv_confidence: "HIGH",
  top_editions: [
    { external_id: "a", thumbnail_url: "pack/1/a.png" },
    { external_id: "b", thumbnail_url: null },
    { external_id: "c", thumbnail_url: "../evil.png" },
  ],
}

beforeEach(() => { rendered.length = 0; state.res = null; state.throws = false })

describe("GET /api/og/product", () => {
  it("renders the product: name, WNBA label, editions seen, 30-day sales on record, safe art only", async () => {
    state.res = { ok: true, product: PRODUCT }
    await GET(req("?slug=2420-prizm-wnba"))
    const o = rendered[0]
    expect(o.title).toBe("2025-26 Panini NFT Prizm WNBA")
    expect(o.subtitle).toBe("WNBA · 3,719 editions seen")
    expect(o.statLabel).toBe("30-day sales on record")
    expect(o.statValue).toBe("$12,346")
    expect(o.images).toEqual(["https://assets.paniniamerica.net/catalog/product/pack/1/a.png"])
    expect(JSON.stringify(o)).not.toMatch(/HIGH|confidence/i)
  })
  it("a failed read is readFailed — never a confident 'no such product'", async () => {
    state.res = { ok: false, product: null }
    await GET(req("?slug=x"))
    expect(rendered[0].readFailed).toBe(true)
    state.throws = true
    await GET(req("?slug=x"))
    expect(rendered[1].readFailed).toBe(true)
  })
  it("an unknown product is a plain card with no counts; no sales means no stat (never $0)", async () => {
    state.res = { ok: true, product: null }
    await GET(req("?slug=nope"))
    expect(rendered[0].readFailed).toBe(false)
    expect(JSON.stringify(rendered[0])).not.toMatch(/editions|\$0/)
    state.res = { ok: true, product: { ...PRODUCT, sales_30d_volume_usd: 0 } }
    await GET(req("?slug=2420-prizm-wnba"))
    expect(rendered[1].statValue).toBeNull()
  })
})
