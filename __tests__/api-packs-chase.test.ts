import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/packs/chase — Top Shot-only "Chase left" read. Pins: a non-Top-Shot
// collection is REFUSED with no rows (substitution rule); a failed page fails
// the whole response (no partial ranked list); paging reads past PostgREST's
// 1000-row cap; the tier filter and availability gate are asked of the DB.

const state: {
  atlasPages: any[][]
  atlasErrAt: number | null
  meta: any[]
  calls: Array<[string, string, ...any[]]>
} = { atlasPages: [[]], atlasErrAt: null, meta: [], calls: [] }

vi.mock("@/lib/collections", () => ({
  COLLECTION_UUID_BY_SLUG: { "nba-top-shot": "uuid-ts", "nfl-all-day": "uuid-ad" },
}))

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    let from = 0
    const b: any = {
      select: () => b,
      eq: (...a: any[]) => { state.calls.push([table, "eq", ...a]); return b },
      gt: (...a: any[]) => { state.calls.push([table, "gt", ...a]); return b },
      gte: (...a: any[]) => { state.calls.push([table, "gte", ...a]); return b },
      or: (...a: any[]) => { state.calls.push([table, "or", ...a]); return b },
      order: () => b,
      range: (f: number) => { from = f; return b },
      then: (resolve: any) => {
        if (table === "topshot_atlas_dists") {
          const page = from / 1000
          if (state.atlasErrAt === page) return resolve({ data: null, error: { message: "boom" } })
          return resolve({ data: state.atlasPages[page] ?? [], error: null })
        }
        return resolve({ data: from === 0 ? state.meta : [], error: null })
      },
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => make(t) } }
})

import { GET } from "@/app/api/packs/chase/route"

const req = (url: string) => ({ url }) as any
const fresh = () => new Date(Date.now() - 3600_000).toISOString()

function atlasRow(id: string, over: Record<string, unknown> = {}) {
  // Every tier, as Dapper sends it: a Common tier keeps the payload self-consistent
  // (3 moments per pack now and at launch) whatever unopened count a case overrides.
  const unopened = Number((over as { unopened_count?: number }).unopened_count ?? 10)
  return {
    dist_id: id,
    title: `Pack ${id}`,
    summary_fetched_at: fresh(),
    unopened_count: 10,
    total_pack_count: 100,
    remaining_by_tier: { legendary: "1", common: String(3 * unopened - 1) },
    original_by_tier: { legendary: "2", common: "298" },
    ...over,
  }
}

beforeEach(() => {
  state.atlasPages = [[]]
  state.atlasErrAt = null
  state.meta = []
  state.calls = []
})

describe("GET /api/packs/chase", () => {
  it("400s without a collection", async () => {
    expect((await GET(req("https://t/api/packs/chase"))).status).toBe(400)
  })

  it("refuses another collection with no rows rather than answering with Top Shot's", async () => {
    const res = await GET(req("https://t/api/packs/chase?collection=nfl-all-day"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.rows).toBeUndefined()
    expect(state.calls).toHaveLength(0)
  })

  it("returns ranked rows and asks the DB for the tier filter", async () => {
    state.atlasPages = [[atlasRow("1"), atlasRow("2", { unopened_count: 5 })]]
    const res = await GET(req("https://t/api/packs/chase?collection=nba-top-shot&tier=legendary"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows.map((r: any) => r.distId)).toEqual(["2", "1"])
    expect(body.total).toBe(2)
    expect(state.calls).toContainEqual(["topshot_atlas_dists", "gt", "remaining_by_tier->>legendary", "0"])
    expect(state.calls).toContainEqual(["topshot_atlas_dists", "gt", "unopened_count", 0])
  })

  it("reads past the 1000-row cap", async () => {
    const page0 = Array.from({ length: 1000 }, (_, i) => atlasRow(String(i)))
    state.atlasPages = [page0, [atlasRow("5000", { unopened_count: 1 })]]
    const body = await (await GET(req("https://t/api/packs/chase?collection=nba-top-shot&limit=1"))).json()
    expect(body.total).toBe(1001)
    expect(body.rows[0].distId).toBe("5000")
  })

  it("a failed later page fails the response — never a partial ranked list", async () => {
    state.atlasPages = [Array.from({ length: 1000 }, (_, i) => atlasRow(String(i)))]
    state.atlasErrAt = 1
    const res = await GET(req("https://t/api/packs/chase?collection=nba-top-shot"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.rows).toBeUndefined()
  })

  it("buyableOnly gates availability on a fresh stamp in the query", async () => {
    state.atlasPages = [[atlasRow("1")]]
    await GET(req("https://t/api/packs/chase?collection=nba-top-shot&buyableOnly=true"))
    expect(state.calls).toContainEqual(["pack_table_rows", "or", "primary_available.eq.true,secondary_available.eq.true"])
    expect(state.calls.some((c) => c[0] === "pack_table_rows" && c[1] === "gte" && c[2] === "ev_snapshotted_at")).toBe(true)
  })
})
