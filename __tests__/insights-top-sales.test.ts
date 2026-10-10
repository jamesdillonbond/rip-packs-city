import { describe, it, expect, beforeEach, vi } from "vitest"

// The Top Sales / Whale Watch surface parses untrusted query params. Both the
// API route and the server page share these parsers so the query shape can't
// drift; pin the safe-default behavior so a bad ?window=/?sort= can never
// reach the DB query unvalidated. Extended (2026-07-12) to cover fetchTopSales:
// the view read (empty / error) and the buyer/seller @handle enrichment via a
// mocked @/lib/flowty-username seam.

// `query` answers v_insights_top_sales; `panini` answers v_panini_top_sales (2026-10-10).
const state: { query: { data: any; error: any }; panini: { data: any; error: any }; calls: string[]; views: string[] } = {
  query: { data: [], error: null },
  panini: { data: [], error: null },
  calls: [],
  views: [],
}

vi.mock("@/lib/supabase", () => {
  const build = (view: string) => {
    state.views.push(view)
    const b: any = {}
    for (const m of ["select", "eq", "in", "order", "limit", "is", "gte", "lt", "not", "ilike"]) {
      b[m] = (...args: any[]) => {
        state.calls.push(`${m}:${JSON.stringify(args)}`)
        return b
      }
    }
    b.then = (resolve: any) => resolve(view === "v_panini_top_sales" ? state.panini : state.query)
    return b
  }
  const client: any = { from: (view: string) => build(view) }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/flowty-username", () => ({
  // Resolve exactly the buyer address; leave the seller unresolved so we can
  // assert both the @handle and the truncated-address fallback paths.
  resolveUsernames: async (_addrs: string[]) => new Map([["0xbuyer", "whale_al"]]),
  displayName: (addr: string, names: Map<string, string>) =>
    names.get((addr || "").toLowerCase()) || `${addr.slice(0, 6)}…`,
}))

import {
  parseWindow,
  parseSort,
  TOP_SALES_VALID_COLLECTIONS,
  fetchTopSales,
} from "@/lib/insights/top-sales"

beforeEach(() => {
  state.query = { data: [], error: null }
  state.panini = { data: [], error: null }
  state.calls = []
  state.views = []
})

describe("parseWindow", () => {
  it("accepts '30d' and defaults everything else to '7d'", () => {
    expect(parseWindow("30d")).toBe("30d")
    expect(parseWindow("7d")).toBe("7d")
    expect(parseWindow("90d")).toBe("7d")
    expect(parseWindow(null)).toBe("7d")
    expect(parseWindow(undefined)).toBe("7d")
    expect(parseWindow("'; DROP TABLE sales;--")).toBe("7d")
  })
})

describe("parseSort", () => {
  it("accepts 'recent' and defaults everything else to 'price'", () => {
    expect(parseSort("recent")).toBe("recent")
    expect(parseSort("price")).toBe("price")
    expect(parseSort("bogus")).toBe("price")
    expect(parseSort(null)).toBe("price")
    expect(parseSort(undefined)).toBe("price")
  })
})

describe("TOP_SALES_VALID_COLLECTIONS", () => {
  // ⚠ CANDY ADDED 2026-09-19, and the reason matters more than the entry. This
  // set is a 400-gate on ?collection=, and it was NARROWER THAN THE VIEW IT
  // GUARDS: `v_insights_top_sales` already carried Candy rows (7 in the 30d
  // window, top sale $203.72, measured that day) and served them under
  // collection=all, while ?collection=candy_mlb answered "collection must be one
  // of …". A filter that rejects data the endpoint already returns is a bug in
  // the filter. Verified against the deployed API after the fix: 200 with 7 rows.
  it("whitelists exactly the 7 collections the board can serve, in DB-slug form", () => {
    expect([...TOP_SALES_VALID_COLLECTIONS].sort()).toEqual(
      [
        "nba_top_shot",
        "nfl_all_day",
        "laliga_golazos",
        "disney_pinnacle",
        "ufc_strike",
        "candy_mlb",
        // 2026-10-10 — served from v_panini_top_sales, merged server-side.
        "panini_blockchain",
      ].sort()
    )
  })

  it("uses DB-slug (underscore) vocabulary, not URL slugs", () => {
    expect(TOP_SALES_VALID_COLLECTIONS.has("ufc_strike")).toBe(true)
    // URL-slug forms must NOT be members — they'd fail the CHECK-constrained query.
    expect(TOP_SALES_VALID_COLLECTIONS.has("ufc")).toBe(false)
    expect(TOP_SALES_VALID_COLLECTIONS.has("nba-top-shot")).toBe(false)
    // Candy is the newest member and the easiest one to add in the wrong
    // vocabulary, since its URL slug and DB slug differ only by the separator.
    expect(TOP_SALES_VALID_COLLECTIONS.has("candy_mlb")).toBe(true)
    expect(TOP_SALES_VALID_COLLECTIONS.has("candy-mlb")).toBe(false)
  })
})

describe("fetchTopSales", () => {
  it("returns an empty board (with fetchedAt) when the view has no rows", async () => {
    state.query = { data: [], error: null }
    const out = await fetchTopSales()
    expect(out.rows).toEqual([])
    expect(typeof out.fetchedAt).toBe("string")
  })

  it("throws on a view read error", async () => {
    state.query = { data: null, error: { message: "view exploded" } }
    await expect(fetchTopSales()).rejects.toThrow("view exploded")
  })

  it("enriches buyer/seller with resolved @handles and truncated fallbacks", async () => {
    state.query = {
      data: [
        {
          sale_id: "s1",
          buyer_address: "0xbuyer",
          seller_address: "0xseller",
          price_usd: 500,
        },
      ],
      error: null,
    }
    const { rows } = await fetchTopSales()
    expect(rows[0].buyer_name).toBe("whale_al") // resolved
    expect(rows[0].seller_name).toBe("0xsell…") // unresolved -> truncated
    expect(rows[0].sale_id).toBe("s1")
  })

  it("leaves name null when an address is missing", async () => {
    state.query = {
      data: [{ sale_id: "s2", buyer_address: null, seller_address: "0xseller" }],
      error: null,
    }
    const { rows } = await fetchTopSales()
    expect(rows[0].buyer_name).toBeNull()
    expect(rows[0].seller_name).toBe("0xsell…")
  })

  it("applies the collection filter only for a whitelisted collection", async () => {
    state.query = { data: [], error: null }
    await fetchTopSales({ collection: "nba_top_shot" })
    expect(state.calls.some((c) => c.startsWith("eq:") && c.includes("nba_top_shot"))).toBe(true)

    state.calls = []
    await fetchTopSales({ collection: "not_a_collection" })
    expect(state.calls.some((c) => c.startsWith("eq:"))).toBe(false)
  })

  it("adds the 7d sold_at floor for the default window and skips it for 30d", async () => {
    state.query = { data: [], error: null }
    await fetchTopSales({ window: "7d" })
    expect(state.calls.some((c) => c.startsWith("gte:") && c.includes("sold_at"))).toBe(true)

    state.calls = []
    await fetchTopSales({ window: "30d" })
    expect(state.calls.some((c) => c.startsWith("gte:"))).toBe(false)
  })
})

describe("fetchTopSales — Panini merge (2026-10-10)", () => {
  const flowRow = { sale_id: "f1", collection: "nba_top_shot", price_usd: 500, sold_at: "2026-10-09T10:00:00Z", buyer_address: "0xbuyer", seller_address: "0xseller" }
  const paniniRow = { sale_id: "p1", collection: "panini_blockchain", price_usd: 900, sold_at: "2026-10-08T10:00:00Z", buyer_address: "EZGOLF", seller_address: "Adlcards" }

  it("collection=all merges both views by price, and shows Panini usernames as-is (never resolved as addresses)", async () => {
    state.query = { data: [flowRow], error: null }
    state.panini = { data: [paniniRow], error: null }
    const { rows } = await fetchTopSales({ window: "30d" })
    expect(state.views.sort()).toEqual(["v_insights_top_sales", "v_panini_top_sales"])
    expect(rows.map((r) => r.sale_id)).toEqual(["p1", "f1"])
    expect(rows[0].buyer_name).toBe("EZGOLF")
    expect(rows[0].seller_name).toBe("Adlcards")
    expect(rows[1].buyer_name).toBe("whale_al")
  })

  it("collection=panini_blockchain reads only the Panini view", async () => {
    state.panini = { data: [paniniRow], error: null }
    await fetchTopSales({ collection: "panini_blockchain" })
    expect(state.views).toEqual(["v_panini_top_sales"])
  })

  it("another collection does not read the Panini view", async () => {
    await fetchTopSales({ collection: "nba_top_shot" })
    expect(state.views).toEqual(["v_insights_top_sales"])
  })

  it("a failed Panini read fails the board — never a 'top sales' list with Panini silently missing", async () => {
    state.query = { data: [flowRow], error: null }
    state.panini = { data: null, error: { message: "boom" } }
    await expect(fetchTopSales({})).rejects.toThrow(/v_panini_top_sales/)
  })

  it("the merged list is cut to the limit after sorting", async () => {
    state.query = { data: [flowRow, { ...flowRow, sale_id: "f2", price_usd: 50 }], error: null }
    state.panini = { data: [paniniRow], error: null }
    const { rows } = await fetchTopSales({ limit: 2 })
    expect(rows.map((r) => r.sale_id)).toEqual(["p1", "f1"])
  })
})
