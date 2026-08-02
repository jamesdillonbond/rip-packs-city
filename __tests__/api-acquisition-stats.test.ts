import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/acquisition-stats.
// Guard: `wallet` query param required → 400. Otherwise resolves a collection id
// then calls the get_acquisition_stats RPC. Mock @/lib/supabase to pin the guard
// plus the happy path (RPC row passthrough) and the RPC-error 500.
//
// The slug→collection resolution is exercised for REAL: the route imports the
// canonical SLUG_TO_DB_SLUG from @/lib/collections (NOT mocked here), and the
// supabase mock is slug-aware, so a wrong hyphen/underscore/short-form mapping
// surfaces as a wrong `.eq("slug", …)` value and a wrong RPC p_collection_id.

const rpc: { data: any; error: any } = { data: null, error: null }
// What the route asked the `collections` table to resolve, and what it passed
// to the RPC — captured so tests can assert the mapping rather than just a 200.
const captured: { slug: string | null; collectionId: string | null } = {
  slug: null,
  collectionId: null,
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    from: () => b,
    select: () => b,
    eq: (_col: string, val: string) => {
      captured.slug = val
      return b
    },
    // Slug-aware: a resolvable slug returns a synthetic id keyed on the slug,
    // an unknown slug misses (→ route falls back to Top Shot). This is what
    // distinguishes "ufc_strike" (resolves) from the old buggy "ufc" (misses).
    single: async () => {
      const known = new Set([
        "nba_top_shot",
        "nfl_all_day",
        "laliga_golazos",
        "disney_pinnacle",
        "ufc_strike",
        "candy_mlb",
        "panini_blockchain",
      ])
      return captured.slug && known.has(captured.slug)
        ? { data: { id: "col-" + captured.slug } }
        : { data: null }
    },
    rpc: async (_name: string, args: any) => {
      captured.collectionId = args?.p_collection_id ?? null
      return { data: rpc.data, error: rpc.error }
    },
  }
  return { supabaseAdmin: b }
})

import { GET } from "@/app/api/acquisition-stats/route"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function req(qs = ""): NextRequest {
  return new NextRequest("https://t/api/acquisition-stats" + qs)
}

beforeEach(() => {
  rpc.data = null
  rpc.error = null
  captured.slug = null
  captured.collectionId = null
})

describe("GET /api/acquisition-stats", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet parameter required")
  })

  it("returns the RPC row for a wallet", async () => {
    rpc.data = [{ total_moments: 12, total_spent: 340, locked_count: 2, breakdown: [] }]
    const res = await GET(req("?wallet=0xabc&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect((await res.json()).total_moments).toBe(12)
  })

  it("500s on an RPC error", async () => {
    rpc.error = { message: "boom" }
    const res = await GET(req("?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Database query failed")
  })

  // Regression: the UFC hyphen slug "ufc" must resolve to the DB slug
  // "ufc_strike". A prior hand-rolled local map used "ufc" → "ufc", which
  // missed the collections row and silently fell back to the Top Shot id,
  // running the RPC against the WRONG collection for every UFC wallet.
  it("resolves the ufc slug to ufc_strike, not the Top Shot fallback", async () => {
    rpc.data = [{ total_moments: 3, total_spent: 40, locked_count: 0, breakdown: [] }]
    const res = await GET(req("?wallet=0xabc&collection=ufc"))
    expect(res.status).toBe(200)
    expect(captured.slug).toBe("ufc_strike")
    expect(captured.collectionId).toBe("col-ufc_strike")
    expect(captured.collectionId).not.toBe(TOPSHOT_COLLECTION_ID)
  })

  it("passes a raw UUID collection param straight through", async () => {
    rpc.data = []
    await GET(req("?wallet=0xabc&collection=9b4824a8-736d-4a96-b450-8dcc0c46b023"))
    // UUID short-circuits the slug lookup entirely.
    expect(captured.collectionId).toBe("9b4824a8-736d-4a96-b450-8dcc0c46b023")
  })

  it("falls back to Top Shot for an unknown slug", async () => {
    rpc.data = []
    await GET(req("?wallet=0xabc&collection=not-a-collection"))
    expect(captured.collectionId).toBe(TOPSHOT_COLLECTION_ID)
  })
})
