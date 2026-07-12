import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/packs/grails.
// Reads pack_grail_metrics_mv, then joins pack_table_rows client-side. Pins:
// missing-collection 400, unknown-collection 400, the empty-grails 200
// ({rows:[]}), and a happy path that joins meta onto the grail rows.

const state: { grails: any; gErr: any; meta: any; mErr: any } = {
  grails: [],
  gErr: null,
  meta: [],
  mErr: null,
}

vi.mock("@/lib/collections", () => ({
  COLLECTION_UUID_BY_SLUG: { "nba-top-shot": "uuid-ts" },
  SLUG_TO_DB_SLUG: { "nba-top-shot": "nba_top_shot" },
}))

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    const payload = () =>
      table === "pack_grail_metrics_mv"
        ? { data: state.grails, error: state.gErr }
        : { data: state.meta, error: state.mErr }
    const b: any = {
      select: () => b,
      eq: () => b,
      gte: () => b,
      in: () => b,
      or: () => b,
      order: () => b,
      limit: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => make(t) } }
})

import { GET } from "@/app/api/packs/grails/route"

const req = (url: string) => ({ url }) as any

beforeEach(() => {
  state.grails = []
  state.gErr = null
  state.meta = []
  state.mErr = null
})

describe("GET /api/packs/grails", () => {
  it("400s when collection is missing", async () => {
    const res = await GET(req("https://t/api/packs/grails"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("collection required")
  })

  it("400s on an unknown collection", async () => {
    const res = await GET(req("https://t/api/packs/grails?collection=made-up"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("unknown collection")
  })

  it("returns an empty rows set when no grail rows match", async () => {
    state.grails = []
    const res = await GET(req("https://t/api/packs/grails?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.collection_id).toBe("uuid-ts")
  })

  it("joins pack_table_rows meta onto grail rows", async () => {
    state.grails = [{ dist_id: "d1", grails_100: 5, max_pull_fmv: 1000 }]
    state.meta = [{ dist_id: "d1", title: "Premium Pack", primary_available: true }]
    const res = await GET(req("https://t/api/packs/grails?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].meta.title).toBe("Premium Pack")
    expect(body.sort).toBe("weightedGrailValue")
  })

  it("accepts the DB underscore collection slug too", async () => {
    state.grails = []
    const res = await GET(req("https://t/api/packs/grails?collection=nba_top_shot"))
    expect(res.status).toBe(200)
    expect((await res.json()).collection_id).toBe("uuid-ts")
  })
})
