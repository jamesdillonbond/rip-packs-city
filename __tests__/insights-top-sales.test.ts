import { describe, it, expect, beforeEach, vi } from "vitest"

// The Top Sales / Whale Watch surface parses untrusted query params. Both the
// API route and the server page share these parsers so the query shape can't
// drift; pin the safe-default behavior so a bad ?window=/?sort= can never
// reach the DB query unvalidated. Extended (2026-07-12) to cover fetchTopSales:
// the view read (empty / error) and the buyer/seller @handle enrichment via a
// mocked @/lib/flowty-username seam.

const state: { query: { data: any; error: any }; calls: string[] } = {
  query: { data: [], error: null },
  calls: [],
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {}
    for (const m of ["select", "eq", "in", "order", "limit", "is", "gte", "lt", "not", "ilike"]) {
      b[m] = (...args: any[]) => {
        state.calls.push(`${m}:${JSON.stringify(args)}`)
        return b
      }
    }
    b.then = (resolve: any) => resolve(state.query)
    return b
  }
  const client: any = { from: () => build() }
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
  state.calls = []
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
  it("whitelists exactly the 5 published DB-slug collections", () => {
    expect([...TOP_SALES_VALID_COLLECTIONS].sort()).toEqual(
      [
        "nba_top_shot",
        "nfl_all_day",
        "laliga_golazos",
        "disney_pinnacle",
        "ufc_strike",
      ].sort()
    )
  })

  it("uses DB-slug (underscore) vocabulary, not URL slugs", () => {
    expect(TOP_SALES_VALID_COLLECTIONS.has("ufc_strike")).toBe(true)
    // URL-slug forms must NOT be members — they'd fail the CHECK-constrained query.
    expect(TOP_SALES_VALID_COLLECTIONS.has("ufc")).toBe(false)
    expect(TOP_SALES_VALID_COLLECTIONS.has("nba-top-shot")).toBe(false)
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
