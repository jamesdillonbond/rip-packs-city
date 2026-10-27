import { describe, it, expect } from "vitest"
import { toOfferRow, packTitle, fetchPaniniEditionPacks, fetchPaniniEditionOffers, fetchPaniniEditionHolders } from "@/lib/panini/edition-extras"

/** A chainable stand-in for the supabase query builder: every call returns itself, and awaiting
 *  it resolves the result registered for the table. */
function fakeDb(results: Record<string, { data?: unknown; error?: unknown; count?: number | null }>) {
  return {
    from(table: string) {
      const res = results[table] ?? { data: [], error: null }
      const q: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(res).then(ok)
            return () => q
          },
        },
      )
      return q
    },
  }
}

describe("toOfferRow", () => {
  it("blank owner = sealed; a listed serial carries its ask, an unlisted one does not", () => {
    expect(toOfferRow({ best_offer_usd: "5", owner: "", is_listed: false, price_usd: 9 })).toMatchObject({ sealed: true, askUsd: null })
    expect(toOfferRow({ best_offer_usd: 5, owner: "someone", is_listed: true, price_usd: 9 })).toMatchObject({ sealed: false, askUsd: 9 })
  })
  it("no handle leaves the row", () => {
    expect(JSON.stringify(toOfferRow({ best_offer_usd: 5, owner: "someone" }))).not.toContain("someone")
  })
  it("a zero / missing offer is not a row", () => {
    expect(toOfferRow({ best_offer_usd: 0 })).toBeNull()
    expect(toOfferRow({})).toBeNull()
  })
})

describe("packTitle", () => {
  it("names typed packs by type and untyped by their published name", () => {
    expect(packTitle("fotl", null)).toBe("FOTL pack")
    expect(packTitle("hobby", "x")).toBe("Hobby pack")
    expect(packTitle("pack", "Red Mosaic")).toBe("Red Mosaic")
  })
})

describe("fetchPaniniEditionPacks", () => {
  // 2026-10-27: one read of panini_pack_state (the packs, their names and their links) — not the EV board
  // view, which recomputes the EV model on every read (23.7k buffers vs 113).
  const state = [
    { id: "1038", pack_type: "hobby", floor_usd: 135, avg_sale_usd: null, packs_total: 5000, packs_remaining: 900, product_name: "WC", pack_name: null, page_url: "https://nft.paniniamerica.net/pack/1038" },
    { id: "1039", pack_type: "fotl", floor_usd: null, avg_sale_usd: 209, packs_total: 2000, packs_remaining: 1400, product_name: "WC", pack_name: null, page_url: "https://evil.example.com/x" },
    { id: "1043", pack_type: "pack", floor_usd: 12, avg_sale_usd: null, packs_total: 100, packs_remaining: 40, product_name: "WC", pack_name: "White Sparkle", page_url: null },
  ]
  it("a FOTL exclusive keeps only FOTL packs; a non-Panini link is dropped", async () => {
    const r = await fetchPaniniEditionPacks("e", fakeDb({
      panini_editions: { data: [{ product_set_id: 2332, still_in_packs: 3, is_fotl_exclusive: true }], error: null },
      panini_pack_state: { data: state, error: null },
    }))
    expect(r.packs?.map((p) => p.id)).toEqual(["1039"])
    expect(r.packs?.[0]).toMatchObject({ costBasis: "avg_sale", marketUrl: null })
  })
  it("a Panini link is kept and an untyped pack takes its published name", async () => {
    const r = await fetchPaniniEditionPacks("e", fakeDb({
      panini_editions: { data: [{ product_set_id: 2332, still_in_packs: 3, is_fotl_exclusive: false }], error: null },
      panini_pack_state: { data: state, error: null },
    }))
    expect(r.packs?.find((p) => p.id === "1038")).toMatchObject({ title: "Hobby pack", marketUrl: "https://nft.paniniamerica.net/pack/1038", costBasis: "floor", costUsd: 135 })
    expect(r.packs?.find((p) => p.id === "1043")?.title).toBe("White Sparkle")
  })
  it("a failed pack read is null, not []", async () => {
    const r = await fetchPaniniEditionPacks("e", fakeDb({
      panini_editions: { data: [{ product_set_id: 2332, still_in_packs: 3, is_fotl_exclusive: false }], error: null },
      panini_pack_state: { data: null, error: { message: "boom" } },
    }))
    expect(r.packs).toBeNull()
    expect(r.stillInPacks).toBe(3)
  })
  it("never reads the EV board view (it recomputes the EV model per read)", async () => {
    const tables: string[] = []
    const db = fakeDb({ panini_editions: { data: [{ product_set_id: 2332, still_in_packs: 3, is_fotl_exclusive: false }], error: null }, panini_pack_state: { data: state, error: null } })
    const spy = { from: (t: string) => { tables.push(t); return db.from(t) } }
    await fetchPaniniEditionPacks("e", spy)
    expect(tables).not.toContain("panini_pack_ev_board")
    expect(tables).toContain("panini_pack_state")
  })
})

describe("fetchPaniniEditionPacks — product link", () => {
  it("carries the product's name and id for the page link", async () => {
    const r = await fetchPaniniEditionPacks("e", fakeDb({
      panini_editions: { data: [{ product_set_id: 1959, still_in_packs: 0, is_fotl_exclusive: false }], error: null },
      panini_products: { data: [{ name: "2023-24 Panini NFT Prizm Basketball" }], error: null },
      panini_pack_state: { data: [], error: null },
    }))
    expect(r).toMatchObject({ productName: "2023-24 Panini NFT Prizm Basketball", productSetId: 1959 })
  })
  it("a failed name read drops the link (no id), never guesses a page", async () => {
    const r = await fetchPaniniEditionPacks("e", fakeDb({
      panini_editions: { data: [{ product_set_id: 1959, still_in_packs: 0, is_fotl_exclusive: false }], error: null },
      panini_products: { data: null, error: { message: "x" } },
      panini_pack_state: { data: [], error: null },
    }))
    expect(r.productSetId).toBeNull()
  })
  it("an edition with no product reads no packs and links nothing", async () => {
    const r = await fetchPaniniEditionPacks("e", fakeDb({ panini_editions: { data: [{ product_set_id: null }], error: null } }))
    expect(r).toMatchObject({ packs: [], productSetId: null })
  })
})

describe("fetchPaniniEditionOffers / Holders", () => {
  it("a failed offers read is null rows, not []", async () => {
    const r = await fetchPaniniEditionOffers("e", fakeDb({ panini_card_serials: { data: null, error: { message: "x" }, count: null } }))
    expect(r.rows).toBeNull()
    expect(r.serialsWithOffer).toBeNull()
  })
  it("holders: failed read is ok:false; missing row is ok:true + null", async () => {
    expect(await fetchPaniniEditionHolders("e", fakeDb({ mv_panini_holder_concentration: { data: null, error: { message: "x" } } }))).toEqual({ ok: false, holders: null })
    expect(await fetchPaniniEditionHolders("e", fakeDb({ mv_panini_holder_concentration: { data: [], error: null } }))).toEqual({ ok: true, holders: null })
  })
})
