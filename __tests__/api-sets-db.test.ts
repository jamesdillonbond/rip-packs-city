import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/sets-db (generic DB-driven sets endpoint).
// Two pre-DB guards: 400 "wallet required" (no ?wallet) and 400 "Unknown
// collection" (slug not in COLLECTION_UUID_MAP). Past those it reads editions /
// sets / wallet_moments_cache via a chained supabaseAdmin builder — mocked here
// to return empty result sets, so the happy path yields zero sets.

const rows: { data: any; error: any } = { data: [], error: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    not: () => b,
    limit: () => b,
    order: () => b,
    range: () => b,
    then: (resolve: any) => resolve(rows),
  }
  return { supabaseAdmin: { from: () => b } }
})

import { GET } from "@/app/api/sets-db/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

describe("GET /api/sets-db", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/sets-db?collection=nba-top-shot"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("400s for an unknown collection slug", async () => {
    const res = await GET(req("https://t/api/sets-db?wallet=0xabc&collection=bogus"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Unknown collection")
  })

  it("returns an empty sets payload when the tables are empty", async () => {
    const res = await GET(req("https://t/api/sets-db?wallet=0xABC&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xabc") // lower-cased by the handler
    expect(body.totalSets).toBe(0)
    expect(body.sets).toEqual([])
  })
})
