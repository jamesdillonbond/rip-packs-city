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

  it("overlays AllDay corrected EV onto matching dists (the v_allday_pack_info merge)", async () => {
    // Regression pin for the corrected-EV merge (fixed 2026-07-19 to fetch scoped
    // to the page's dist_ids). d1 has a matching corrected row -> its modeled EV
    // is overwritten with the odds-robust corrected EV; d2 has no corrected row
    // -> it passes through unchanged.
    tables.pack_table_rows = {
      data: [
        { dist_id: "d1", title: "Rare Pack", gross_ev: 430, pack_ev: 425, value_ratio: 86, ev_margin_pct: 8500 },
        { dist_id: "d2", title: "Plain Pack", gross_ev: 5, pack_ev: 2, value_ratio: 1.1, ev_margin_pct: 10 },
      ],
      count: 2,
      error: null,
    }
    tables.v_allday_pack_info = {
      data: [
        { dist_id: "d1", corrected_gross_ev: 12, corrected_net_ev: 7, corrected_value_ratio: 1.4, ev_method: "median", low_confidence_ev: true },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/packs?collection=nfl-all-day"))
    expect(res.status).toBe(200)
    const body = await res.json()
    const d1 = body.rows.find((r: any) => r.dist_id === "d1")
    const d2 = body.rows.find((r: any) => r.dist_id === "d2")
    // corrected EV overwrites the over-stated modeled EV
    expect(d1.gross_ev).toBe(12)
    expect(d1.pack_ev).toBe(7)
    expect(d1.value_ratio).toBe(1.4)
    expect(d1.ev_margin_pct).toBeCloseTo(40) // (1.4 - 1) * 100
    expect(d1.low_confidence_ev).toBe(true)
    expect(d1.ev_method).toBe("median")
    // no corrected row -> untouched modeled EV
    expect(d2.gross_ev).toBe(5)
    expect(d2.ev_method).toBeUndefined()
  })

  it("overlays Top Shot calibrated EV onto matching dists (the v_topshot_pack_ev_calibrated merge)", async () => {
    tables.pack_table_rows = {
      data: [{ dist_id: "t1", title: "TS Pack", gross_ev: 37, pack_ev: 32 }],
      count: 1,
      error: null,
    }
    tables.v_topshot_pack_ev_calibrated = {
      data: [
        { dist_id: "t1", calibrated_gross_ev: 18, calibrated_net_ev: 13, calibrated_margin_pct: 25, calibration_applied: true },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/packs?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    const t1 = body.rows.find((r: any) => r.dist_id === "t1")
    expect(t1.calibrated_gross_ev).toBe(18)
    expect(t1.calibrated_net_ev).toBe(13)
    expect(t1.calibration_applied).toBe(true)
  })
})
