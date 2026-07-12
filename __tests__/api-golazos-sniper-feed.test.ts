import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/golazos-sniper-feed.
// Public, no-auth read. The module constructs its own client via
// createClient(@supabase/supabase-js) at import, so we mock that with a
// thenable builder (mirrors api-fmv-demo). Pins the empty-cache happy path
// and the 500-on-query-error path.

const tables: Record<string, { data: any; error?: any }> = {}

vi.mock("@supabase/supabase-js", () => {
  const builder = (table: string) => {
    const payload = () => tables[table] ?? { data: [], error: null }
    const b: any = {
      select: () => b,
      eq: () => b,
      gt: () => b,
      order: () => b,
      in: () => b,
      limit: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  return { createClient: () => ({ from: (t: string) => builder(t) }) }
})

import { GET } from "@/app/api/golazos-sniper-feed/route"

const req = (qs = "") => ({ nextUrl: new URL("https://t/api/golazos-sniper-feed" + qs) }) as any

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
})

describe("GET /api/golazos-sniper-feed", () => {
  it("returns an empty deals payload when cached_listings is empty", async () => {
    tables.cached_listings = { data: [] }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(0)
    expect(body.flowtyCount).toBe(0)
    expect(body.deals).toEqual([])
  })

  it("500s on a cached_listings query error", async () => {
    tables.cached_listings = { data: null, error: { message: "db down" } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })

  it("still 200s with a tier filter applied to an empty cache", async () => {
    tables.cached_listings = { data: [] }
    const res = await GET(req("?tier=RARE&minDiscount=10"))
    expect(res.status).toBe(200)
    expect((await res.json()).count).toBe(0)
  })
})
