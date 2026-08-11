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

  it("overlays AllDay corrected EV onto matching dists (the v_allday_pack_detail_ev merge)", async () => {
    // Regression pin for the corrected-EV merge (fixed 2026-07-19 to fetch scoped
    // to the page's dist_ids). d1 has a matching corrected row -> its modeled EV
    // is overwritten with the odds-robust corrected EV; d2 has no corrected row
    // -> it passes through unchanged.
    // Source repointed 2026-08-09 from v_allday_pack_info to the lean
    // v_allday_pack_detail_ev (identical columns/values, without the 1.19M-cost
    // pack_ev_latest join). The fixture key IS the assertion that the route reads
    // the lean view: leaving it on the old name makes the merge silently no-op.
    tables.pack_table_rows = {
      data: [
        { dist_id: "d1", title: "Rare Pack", gross_ev: 430, pack_ev: 425, value_ratio: 86, ev_margin_pct: 8500 },
        { dist_id: "d2", title: "Plain Pack", gross_ev: 5, pack_ev: 2, value_ratio: 1.1, ev_margin_pct: 10 },
      ],
      count: 2,
      error: null,
    }
    tables.v_allday_pack_detail_ev = {
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

  // ── sort + param handling ──────────────────────────────────────────────
  it.each([
    ["ev_margin_pct_desc"],
    ["retail_price_asc"],
    ["title_asc"],
    ["value_ratio_desc"],
    ["bogus-sort"], // invalid -> falls back to value_ratio_desc
  ])("accepts sort=%s and returns 200", async (sort) => {
    tables.pack_table_rows = { data: [{ dist_id: "g1", title: "G" }], count: 1, error: null }
    const res = await GET(req("https://t/api/packs?collection=laliga-golazos&sort=" + sort))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toHaveLength(1)
  })

  it("applies the tier and search filters without error", async () => {
    tables.pack_table_rows = { data: [{ dist_id: "g1", title: "G" }], count: 1, error: null }
    const res = await GET(req("https://t/api/packs?collection=laliga-golazos&tier=RARE&search=cup"))
    expect(res.status).toBe(200)
    expect((await res.json()).total).toBe(1)
  })

  it.each([
    ["5000", 200], // clamps to 1000 max
    ["0", 200],    // clamps up to 1
    ["notanumber", 200], // NaN -> 100
  ])("clamps limit=%s", async (limit, status) => {
    tables.pack_table_rows = { data: [], count: 0, error: null }
    const res = await GET(req("https://t/api/packs?collection=laliga-golazos&limit=" + limit))
    expect(res.status).toBe(status)
  })

  it("tolerates a null data payload with no error", async () => {
    tables.pack_table_rows = { data: null, count: null, error: null }
    const res = await GET(req("https://t/api/packs?collection=laliga-golazos"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.total).toBe(0)
  })

  // ── Top Shot calibrated merge: non-fatal edges ─────────────────────────
  it("keeps modeled EV when the TS calibrated view errors (non-fatal)", async () => {
    tables.pack_table_rows = { data: [{ dist_id: "t1", title: "TS", gross_ev: 37 }], count: 1, error: null }
    tables.v_topshot_pack_ev_calibrated = { data: null, error: { message: "cal boom" } }
    const res = await GET(req("https://t/api/packs?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const t1 = (await res.json()).rows.find((r: any) => r.dist_id === "t1")
    expect(t1.gross_ev).toBe(37)
    expect(t1.calibrated_gross_ev).toBeUndefined()
  })

  it("passes a TS row through untouched when it has no calibrated match", async () => {
    tables.pack_table_rows = {
      data: [
        { dist_id: "t1", title: "Matched", gross_ev: 37 },
        { dist_id: "t2", title: "Unmatched", gross_ev: 9 },
      ],
      count: 2,
      error: null,
    }
    tables.v_topshot_pack_ev_calibrated = {
      data: [{ dist_id: "t1", calibrated_gross_ev: 18, calibrated_net_ev: 13, calibrated_margin_pct: 25, calibration_applied: true }],
      error: null,
    }
    const rows = (await (await GET(req("https://t/api/packs?collection=nba-top-shot"))).json()).rows
    expect(rows.find((r: any) => r.dist_id === "t1").calibrated_gross_ev).toBe(18)
    expect(rows.find((r: any) => r.dist_id === "t2").calibrated_gross_ev).toBeUndefined()
  })

  // ── All Day corrected merge: non-fatal edges ───────────────────────────
  it("keeps modeled EV when the AllDay corrected view errors (non-fatal)", async () => {
    tables.pack_table_rows = { data: [{ dist_id: "d1", title: "AD", gross_ev: 430 }], count: 1, error: null }
    tables.v_allday_pack_detail_ev = { data: null, error: { message: "corr boom" } }
    const res = await GET(req("https://t/api/packs?collection=nfl-all-day"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows[0].gross_ev).toBe(430)
  })

  it("skips an AllDay corrected row with a null corrected_gross_ev", async () => {
    tables.pack_table_rows = { data: [{ dist_id: "d1", title: "AD", gross_ev: 430, ev_margin_pct: 8500 }], count: 1, error: null }
    tables.v_allday_pack_detail_ev = {
      data: [{ dist_id: "d1", corrected_gross_ev: null, corrected_net_ev: null, corrected_value_ratio: null }],
      error: null,
    }
    const d1 = (await (await GET(req("https://t/api/packs?collection=nfl-all-day"))).json()).rows[0]
    expect(d1.gross_ev).toBe(430) // untouched
  })

  it("keeps ev_margin_pct when the AllDay corrected_value_ratio is null", async () => {
    tables.pack_table_rows = { data: [{ dist_id: "d1", title: "AD", gross_ev: 430, ev_margin_pct: 8500 }], count: 1, error: null }
    tables.v_allday_pack_detail_ev = {
      data: [{ dist_id: "d1", corrected_gross_ev: 12, corrected_net_ev: 7, corrected_value_ratio: null, ev_method: "median", low_confidence_ev: true }],
      error: null,
    }
    const d1 = (await (await GET(req("https://t/api/packs?collection=nfl-all-day"))).json()).rows[0]
    expect(d1.gross_ev).toBe(12)
    expect(d1.value_ratio).toBeNull()
    expect(d1.ev_margin_pct).toBe(8500) // preserved because ratio was null
  })

  // ── Disney Pinnacle corrected merge (entirely uncovered branch) ─────────
  it("overlays Pinnacle corrected EV onto matching dists", async () => {
    tables.pack_table_rows = {
      data: [
        { dist_id: "p1", title: "Summer Splash", gross_ev: 531, pack_ev: 520, value_ratio: 100, ev_margin_pct: 9900 },
        { dist_id: "p2", title: "Plain Pin Pack", gross_ev: 5, pack_ev: 2, value_ratio: 1.1, ev_margin_pct: 10 },
      ],
      count: 2,
      error: null,
    }
    tables.v_pinnacle_pack_ev_corrected = {
      data: [{ dist_id: "p1", corrected_gross_ev: 14, corrected_net_ev: 8, corrected_value_ratio: 1.5, ev_method: "median_within_supply", low_confidence_ev: true }],
      error: null,
    }
    const res = await GET(req("https://t/api/packs?collection=disney-pinnacle"))
    expect(res.status).toBe(200)
    const body = await res.json()
    const p1 = body.rows.find((r: any) => r.dist_id === "p1")
    const p2 = body.rows.find((r: any) => r.dist_id === "p2")
    expect(p1.gross_ev).toBe(14)
    expect(p1.pack_ev).toBe(8)
    expect(p1.value_ratio).toBe(1.5)
    expect(p1.ev_margin_pct).toBeCloseTo(50) // (1.5 - 1) * 100
    expect(p1.low_confidence_ev).toBe(true)
    expect(p1.ev_method).toBe("median_within_supply")
    expect(p2.gross_ev).toBe(5) // no corrected row -> untouched
    // Pinnacle has no drop-pool basis -> ev_basis null
    expect(body.ev_basis).toBeNull()
  })

  it("keeps modeled EV when the Pinnacle corrected view errors (non-fatal)", async () => {
    tables.pack_table_rows = { data: [{ dist_id: "p1", title: "Pin", gross_ev: 531 }], count: 1, error: null }
    tables.v_pinnacle_pack_ev_corrected = { data: null, error: { message: "pin corr boom" } }
    const res = await GET(req("https://t/api/packs?collection=disney-pinnacle"))
    expect(res.status).toBe(200)
    expect((await res.json()).rows[0].gross_ev).toBe(531)
  })

  // ── availability disclosure + counts ───────────────────────────────────
  it("labels each row's availability and tallies availability_counts", async () => {
    tables.pack_table_rows = {
      data: [
        { dist_id: "a", title: "On sale", primary_available: true, secondary_available: false },
        { dist_id: "b", title: "Secondary", primary_available: false, secondary_available: true },
        { dist_id: "c", title: "Retired", primary_available: false, secondary_available: false },
        { dist_id: "d", title: "Unknown" }, // both flags absent
      ],
      count: 4,
      error: null,
    }
    const body = await (await GET(req("https://t/api/packs?collection=laliga-golazos"))).json()
    const byId = Object.fromEntries(body.rows.map((r: any) => [r.dist_id, r]))
    expect(byId.a.pack_availability).toBe("primary")
    expect(byId.a.ev_is_historical).toBe(false)
    expect(byId.b.pack_availability).toBe("secondary")
    expect(byId.c.pack_availability).toBe("retired")
    expect(byId.c.ev_is_historical).toBe(true)
    expect(byId.d.pack_availability).toBe("unknown")
    expect(body.availability_counts).toEqual({ primary: 1, secondary: 1, retired: 1 })
  })

  it("reports the ev_basis for a modeled collection", async () => {
    tables.pack_table_rows = { data: [{ dist_id: "g1", title: "G" }], count: 1, error: null }
    const body = await (await GET(req("https://t/api/packs?collection=laliga-golazos"))).json()
    expect(body.ev_basis).toMatchObject({ basis: "original" })
  })
})
