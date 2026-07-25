import { describe, it, expect } from "vitest"
import {
  isPinnacle,
  searchPinnacleDeals,
  getPinnacleFmv,
  explainPinnacleFmv,
  searchPinnacleByName,
} from "@/lib/concierge/pinnacle-router"

// The Pinnacle concierge router quotes PER-RENDER FMV from pinnacle_catalog and
// must never leak character/FMV across pins: (character,set,variant) is 1:1 with
// a render, and a set-level legacy_edition_key that spans renders is collapsed to
// a representative (most-traded 30d, tiebreak highest FMV) with the spread
// surfaced. These tests pin that collapse + the discount math + every status
// branch. The module takes `supabase` as a param, so a chainable query-builder
// mock drives it directly.

// Chainable thenable query-builder mock — every method returns itself; awaiting
// resolves the configured { data, error }.
function makeSupabase(result: { data: any; error?: any }) {
  const qb: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (resolve: any) => Promise.resolve({ error: null, ...result }).then(resolve)
        return () => qb
      },
    }
  )
  return { from: () => qb }
}

describe("isPinnacle", () => {
  it("is true only for disney-pinnacle", () => {
    expect(isPinnacle("disney-pinnacle")).toBe(true)
  })
  it("is false for other collections + nullish", () => {
    expect(isPinnacle("nba-top-shot")).toBe(false)
    expect(isPinnacle("ufc")).toBe(false)
    expect(isPinnacle(null)).toBe(false)
    expect(isPinnacle(undefined)).toBe(false)
  })
})

describe("searchPinnacleDeals", () => {
  it("enriches listings with a discount and labels the source (live→pinnacle)", async () => {
    const sb = makeSupabase({
      data: [
        { render_id: "r1", character_name: "Mickey", set_name: "Star Wars", variant: "Golden", floor_ask: 8, fmv_usd: 10, fmv_confidence: "HIGH" },
      ],
    })
    const out = JSON.parse(await searchPinnacleDeals(sb, { player: "Mickey", tier: "Golden", maxPrice: 20 }))
    expect(out.status).toBe("ok")
    expect(out.source).toBe("pinnacle_native")
    expect(out.results[0]).toMatchObject({ player: "Mickey", tier: "Golden", price: 8, fmv: 10, discount_pct: 20, source: "pinnacle" })
  })

  it("labels the catalog source when opts.source is catalog", async () => {
    const sb = makeSupabase({ data: [{ render_id: "r1", character_name: "M", set_name: "S", variant: "V", floor_ask: 5, fmv_usd: 5, fmv_confidence: "LOW" }] })
    const out = JSON.parse(await searchPinnacleDeals(sb, {}, { source: "catalog" }))
    expect(out.source).toBe("pinnacle_catalog")
    expect(out.results[0].source).toBe("catalog")
  })

  it("returns no_results when the catalog has no matching listings", async () => {
    const out = JSON.parse(await searchPinnacleDeals(makeSupabase({ data: [] }), { player: "Nobody" }))
    expect(out.status).toBe("no_results")
  })

  it("returns an error status when the query errors", async () => {
    const out = JSON.parse(await searchPinnacleDeals(makeSupabase({ data: null, error: { message: "boom" } }), {}))
    expect(out.status).toBe("error")
    expect(out.message).toBe("boom")
  })

  it("applies minDiscount and returns no_results when nothing clears the threshold", async () => {
    const sb = makeSupabase({
      data: [{ render_id: "r1", character_name: "M", set_name: "S", variant: "V", floor_ask: 9, fmv_usd: 10, fmv_confidence: "HIGH" }], // 10% discount
    })
    const out = JSON.parse(await searchPinnacleDeals(sb, { minDiscount: 50 }))
    expect(out.status).toBe("no_results")
  })
})

describe("getPinnacleFmv", () => {
  it("collapses a multi-render legacy key to the most-traded rep and surfaces the spread", async () => {
    const sb = makeSupabase({
      data: [
        { render_id: "r1", character_name: "Luke", set_name: "SW", variant: "Golden", fmv_usd: 30, fmv_confidence: "MEDIUM", fmv_sales_count_30d: 2, fmv_wap_usd: 28, floor_ask: 25, fmv_computed_at: "2026-07-19T00:00:00Z" },
        { render_id: "r2", character_name: "Leia", set_name: "SW", variant: "Golden", fmv_usd: 90, fmv_confidence: "HIGH", fmv_sales_count_30d: 9, fmv_wap_usd: 80, floor_ask: 70, fmv_computed_at: "2026-07-19T00:00:00Z" },
      ],
    })
    const out = JSON.parse(await getPinnacleFmv(sb, { editionKey: "STAR-OEV1-SWAL:Golden:1" }))
    expect(out.status).toBe("ok")
    // rep = the render with the MOST 30d sales (r2, 9 sales), not the highest fmv order in the array
    expect(out.player).toBe("Leia")
    expect(out.fmv).toBe(90)
    expect(out.confidence).toBe("high")
    expect(out.fmv_render_range).toEqual({ min: 30, max: 90, renders: 2 })
  })

  it("returns no_data when the key has no priced render", async () => {
    const out = JSON.parse(await getPinnacleFmv(makeSupabase({ data: [] }), { editionKey: "k" }))
    expect(out.status).toBe("no_data")
  })

  it("searches by character name and returns up to 5 priced renders", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      render_id: `r${i}`, character_name: "Mickey", set_name: "S", variant: "V", fmv_usd: 10 + i, fmv_confidence: "LOW", floor_ask: 5,
    }))
    const out = JSON.parse(await getPinnacleFmv(makeSupabase({ data: rows }), { playerName: "Mickey" }))
    expect(out.status).toBe("ok")
    expect(out.results).toHaveLength(5)
    expect(out.results[0].player).toBe("Mickey")
  })

  it("returns not_found for a character with no priced renders", async () => {
    const out = JSON.parse(await getPinnacleFmv(makeSupabase({ data: [] }), { playerName: "Ghost" }))
    expect(out.status).toBe("not_found")
  })

  it("errors when neither editionKey nor playerName is supplied", async () => {
    const out = JSON.parse(await getPinnacleFmv(makeSupabase({ data: [] }), {}))
    expect(out.status).toBe("error")
    expect(out.message).toMatch(/editionKey or playerName/)
  })
})

describe("explainPinnacleFmv", () => {
  it("builds a human explanation, with a render-range note for a multi-render key", async () => {
    const sb = makeSupabase({
      data: [
        { render_id: "r1", character_name: "Luke", set_name: "SW", variant: "Golden", fmv_usd: 30, fmv_confidence: "LOW", fmv_sales_count_30d: 1, fmv_wap_usd: 28, floor_ask: 25, fmv_computed_at: new Date().toISOString() },
        { render_id: "r2", character_name: "Leia", set_name: "SW", variant: "Golden", fmv_usd: 90, fmv_confidence: "HIGH", fmv_sales_count_30d: 5, fmv_wap_usd: 80, floor_ask: 70, fmv_computed_at: new Date().toISOString() },
      ],
    })
    const out = JSON.parse(await explainPinnacleFmv(sb, { editionKey: "k" }))
    expect(out.status).toBe("ok")
    expect(out.explanation).toContain("Pinnacle FMV is $90.00")
    expect(out.explanation).toContain("spans 2 renders")
  })

  it("errors without an editionKey", async () => {
    const out = JSON.parse(await explainPinnacleFmv(makeSupabase({ data: [] }), { editionKey: "" }))
    expect(out.status).toBe("error")
  })

  it("returns no_data when the key has no priced render", async () => {
    const out = JSON.parse(await explainPinnacleFmv(makeSupabase({ data: [] }), { editionKey: "k" }))
    expect(out.status).toBe("no_data")
  })
})

describe("searchPinnacleByName", () => {
  it("returns the cross-collection group shape with per-render discount", async () => {
    const sb = makeSupabase({
      data: [{ render_id: "r1", character_name: "Mickey", set_name: "S", variant: "Golden", floor_ask: 6, fmv_usd: 12, fmv_confidence: "HIGH" }],
    })
    const group = await searchPinnacleByName(sb, "Mickey", 5)
    expect(group.collection).toBe("Disney Pinnacle")
    expect(group.collectionId).toBe("disney-pinnacle")
    expect(group.results[0]).toMatchObject({ player: "Mickey", price: 6, fmv: 12, discount_pct: 50 })
  })

  it("tolerates an empty result set", async () => {
    const group = await searchPinnacleByName(makeSupabase({ data: null }), "Nobody", 5)
    expect(group.results).toEqual([])
  })
})

// ── The three catch arms ─────────────────────────────────────────────────────
// This router is a CONCIERGE tool: its return value is fed straight back to the
// model as a tool result. A throw here would surface to the user as a broken
// chat turn, so each entry point wraps its DB work and returns a structured
// {status:"error"} envelope instead. These pin that contract — including that
// the thrown message is carried through (so an operator can see WHAT failed in
// support_conversations) rather than swallowed behind a generic string.
function throwingSupabase(message: string) {
  const qb: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.reject(new Error(message)).then(res, rej)
        return () => qb
      },
    }
  )
  return { from: () => qb } as never
}

describe("pinnacle-router — DB failures return an error envelope, never a throw", () => {
  it("searchPinnacleDeals", async () => {
    const out = JSON.parse(await searchPinnacleDeals(throwingSupabase("catalog down"), { player: "Goofy" }))
    expect(out.status).toBe("error")
    expect(out.message).toBe("catalog down")
  })

  it("getPinnacleFmv", async () => {
    const out = JSON.parse(await getPinnacleFmv(throwingSupabase("fmv read down"), { editionKey: "A:B:1" }))
    expect(out.status).toBe("error")
    expect(out.message).toBe("fmv read down")
  })

  it("explainPinnacleFmv", async () => {
    const out = JSON.parse(await explainPinnacleFmv(throwingSupabase("explain down"), { editionKey: "A:B:1" }))
    expect(out.status).toBe("error")
    expect(out.message).toBe("explain down")
  })

  // searchPinnacleByName is deliberately the ODD ONE OUT: it returns a typed
  // group object rather than a JSON envelope, and its only caller
  // (support-chat's search_across_collections) wraps the whole Promise.all in
  // its own try/catch. So it must PROPAGATE — if someone later "fixes" it to
  // swallow and return an empty group, the concierge would report a clean
  // "0 results across collections" for what is actually a DB outage.
  it("searchPinnacleByName propagates instead of swallowing (its caller is the boundary)", async () => {
    await expect(searchPinnacleByName(throwingSupabase("name search down"), "Goofy", 3)).rejects.toThrow(
      "name search down",
    )
  })
})
