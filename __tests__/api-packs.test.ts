import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/packs. The handler builds a filtered/sorted
// query against the `pack_table_rows` view via createClient from
// @supabase/supabase-js (mirrors the fmv-demo mock approach). Pins: the
// collection allow-list 400 guard (returns before any DB call), the query-error
// 500 path, an empty happy path (nfl-all-day, no corrected-EV merge because
// rows are empty), and a non-empty happy path (laliga-golazos — the one allowed
// collection with no secondary merge query) asserting the {rows,total,
// collection_slug} response shape.

const tables: Record<string, { data: any; count?: any; error?: any }> = {}

vi.mock("@supabase/supabase-js", () => {
  const builder = (table: string) => {
    const payload = () => tables[table] ?? { data: [], count: 0, error: null }
    const b: any = {
      select: () => b,
      eq: () => b,
      in: () => b,
      ilike: () => b,
      not: () => b,
      order: () => b,
      limit: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  return { createClient: () => ({ from: (t: string) => builder(t) }) }
})

import { GET } from "@/app/api/packs/route"

const req = (url: string) => ({ nextUrl: new URL(url), url }) as any

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
})

describe("GET /api/packs", () => {
  it("400s when the collection is missing", async () => {
    const res = await GET(req("https://t/api/packs"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("collection must be one of")
  })

  it("400s on a collection outside the allow-list", async () => {
    const res = await GET(req("https://t/api/packs?collection=ufc-strike"))
    expect(res.status).toBe(400)
  })

  it("500s when the pack_table_rows query errors", async () => {
    tables.pack_table_rows = { data: null, count: null, error: { message: "view exploded" } }
    const res = await GET(req("https://t/api/packs?collection=nba-top-shot"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("view exploded")
  })

  it("returns an empty result set with the collection echoed back", async () => {
    tables.pack_table_rows = { data: [], count: 0, error: null }
    const res = await GET(req("https://t/api/packs?collection=nfl-all-day"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.total).toBe(0)
    expect(body.collection_slug).toBe("nfl-all-day")
  })

  it("returns rows and total for a non-empty collection (no merge branch)", async () => {
    // laliga-golazos is the only allowed collection with no secondary
    // corrected-EV merge, so the single pack_table_rows payload is the response.
    tables.pack_table_rows = {
      data: [
        { dist_id: "d1", title: "Golazos Pack", value_ratio: 1.2 },
        { dist_id: "d2", title: "Another Pack", value_ratio: 0.9 },
      ],
      count: 2,
      error: null,
    }
    const res = await GET(req("https://t/api/packs?collection=laliga-golazos"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(2)
    expect(body.total).toBe(2)
    expect(body.collection_slug).toBe("laliga-golazos")
  })
})
