import { describe, it, expect } from "vitest"
import { selectPackPages } from "../scripts/panini-pack-pages.mjs"

const sub = (n: number) => `https://nft.paniniamerica.net/marketplace-details/subpack-${n}-${n}.html`
const drop = (name: string) => `https://nft.paniniamerica.net/pack-${name}.html`

describe("selectPackPages — which pack pages a runner opens", () => {
  it("a never-walked DROP page at the head of the stalest-first list is opened even when subpack pages outnumber the cap", () => {
    // 2026-11-22: 404 subpack pages, cap 60 — the old whole-list subpack-first sort kept the NWSL
    // (#1065) drop page out of every run since it was registered on 11-13.
    const nwsl = drop("2026_Panini_NFT_Prizm_Black_NWSL_Soccer_Packs")
    const served = [nwsl, ...Array.from({ length: 404 }, (_, i) => sub(i))]
    const picked = selectPackPages(served, [], 60)
    expect(picked).toHaveLength(60)
    expect(picked).toContain(nwsl)
  })

  it("takes the cap from the route's stalest-first order, never from further down the list", () => {
    const served = [sub(1), drop("a"), sub(2), drop("b"), sub(3)]
    const picked = selectPackPages(served, [], 3)
    expect(new Set(picked)).toEqual(new Set([sub(1), drop("a"), sub(2)]))
    expect(picked).not.toContain(drop("b"))
  })

  it("orders subpack pages first WITHIN the slice (a product keeps its numeric pack id)", () => {
    const picked = selectPackPages([drop("a"), sub(1), drop("b"), sub(2)], [], 4)
    expect(picked).toEqual([sub(1), sub(2), drop("a"), drop("b")])
  })

  it("appends harvested links after the served list and de-duplicates", () => {
    const picked = selectPackPages([sub(1)], [sub(1), drop("new")], 10)
    expect(picked).toEqual([sub(1), drop("new")])
  })

  it("opens nothing for a missing or non-positive cap", () => {
    expect(selectPackPages([sub(1)], [], 0)).toEqual([])
    expect(selectPackPages([sub(1)], [], Number.NaN)).toEqual([])
  })
})
