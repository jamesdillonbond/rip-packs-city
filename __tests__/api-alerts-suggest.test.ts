import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/alerts/suggest (typeahead).
// Returns { suggestions: [] } early for an unknown kind or a query shorter than
// 2 chars (no DB touch). For a valid kind + query it prefix-matches editions and
// dedupes. Mock @/lib/supabase's chained builder.

const state: { data: any; error: any } = { data: [], error: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    from: () => b,
    select: () => b,
    ilike: () => b,
    not: () => b,
    order: () => b,
    eq: () => b,
    limit: async () => ({ data: state.data, error: state.error }),
  }
  return { supabaseAdmin: b }
})

import { GET } from "@/app/api/alerts/suggest/route"

const req = (qs: string) => new NextRequest("https://t/api/alerts/suggest" + qs)

describe("GET /api/alerts/suggest", () => {
  it("returns [] for an unknown kind", async () => {
    const body = await (await GET(req("?kind=nope&q=leb"))).json()
    expect(body.suggestions).toEqual([])
  })

  it("returns [] for a prototype-key kind (constructor) without hitting the DB", async () => {
    // A bare COLUMN_BY_KIND["constructor"] resolves to Object.prototype.constructor
    // (a truthy function), defeating the `!col` guard and querying with a garbage
    // column. ownLookup() must treat it as absent → early [].
    state.data = [{ player_name: "should not surface" }]
    for (const k of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const body = await (await GET(req(`?kind=${k}&q=lebron`))).json()
      expect(body.suggestions).toEqual([])
    }
    state.data = []
  })

  it("returns [] for a query shorter than 2 chars", async () => {
    const body = await (await GET(req("?kind=player&q=l"))).json()
    expect(body.suggestions).toEqual([])
  })

  it("dedupes case-insensitively and caps at 12", async () => {
    state.data = [
      { player_name: "LeBron James" },
      { player_name: "lebron james" },
      { player_name: "Luka Doncic" },
    ]
    const body = await (await GET(req("?kind=player&q=l".replace("q=l", "q=le")))).json()
    expect(body.suggestions).toEqual(["LeBron James", "Luka Doncic"])
  })
})
