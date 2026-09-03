import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/packs/grails.
// Reads pack_grail_metrics_mv, then joins pack_table_rows client-side. Pins:
// missing-collection 400, unknown-collection 400, the empty-grails 200
// ({rows:[]}), and a happy path that joins meta onto the grail rows.

const state: { grails: any; gErr: any; meta: any; mErr: any; calls: Array<[string, ...any[]]> } = {
  grails: [],
  gErr: null,
  meta: [],
  mErr: null,
  // Every filter the route applies to the pack_table_rows side, in order. The
  // 2026-09-03 freshness gate is a CLAIM about the query, not about the payload
  // (the mock returns whatever it is given), so it is pinned by what was asked.
  calls: [],
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
      gte: (...a: any[]) => { if (table === "pack_table_rows") state.calls.push(["gte", ...a]); return b },
      in: () => b,
      or: (...a: any[]) => { if (table === "pack_table_rows") state.calls.push(["or", ...a]); return b },
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
  state.calls = []
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

// ── 2026-09-03: "buyable" is an affirmative claim, so it is freshness-gated ──
//
// primary_available / secondary_available are columns on the pack_ev_latest
// snapshot, exactly as fresh as ev_snapshotted_at. Measured the day this landed:
// 654 of 1,210 Top Shot rows over three days old still said secondary_available,
// the oldest 135 days. The same 72 h bar the pack page and deals surface use.
describe("GET /api/packs/grails — buyableOnly is freshness-gated", () => {
  it("applies the availability OR **and** an ev_snapshotted_at lower bound inside the 72 h bar", async () => {
    state.grails = [{ dist_id: "d1", grails_100: 5, max_pull_fmv: 1000 }]
    state.meta = [{ dist_id: "d1", title: "Premium Pack", secondary_available: true }]
    const before = Date.now()
    const res = await GET(req("https://t/api/packs/grails?collection=nba-top-shot&buyableOnly=true"))
    expect(res.status).toBe(200)

    const or = state.calls.find((c) => c[0] === "or")
    expect(or?.[1]).toBe("primary_available.eq.true,secondary_available.eq.true")

    const gte = state.calls.find((c) => c[0] === "gte")
    expect(gte, "no ev_snapshotted_at bound was applied").toBeDefined()
    expect(gte![1]).toBe("ev_snapshotted_at")
    const cutoff = Date.parse(gte![2])
    // 72 h ago, give or take the test's own wall clock.
    expect(before - cutoff).toBeGreaterThan(71 * 3600 * 1000)
    expect(before - cutoff).toBeLessThan(73 * 3600 * 1000)
  })

  it("applies NEITHER filter when buyableOnly is off — the leaderboard still shows every pack", async () => {
    state.grails = [{ dist_id: "d1", grails_100: 5, max_pull_fmv: 1000 }]
    state.meta = [{ dist_id: "d1", title: "Premium Pack" }]
    const res = await GET(req("https://t/api/packs/grails?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect(state.calls.some((c) => c[0] === "or")).toBe(false)
    expect(state.calls.some((c) => c[0] === "gte")).toBe(false)
  })
})
