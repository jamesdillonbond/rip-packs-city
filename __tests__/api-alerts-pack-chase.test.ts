import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// /api/alerts/pack-chase — session-authed pack-chase watches. Pins: 401 signed out;
// owner_key is the SESSION id (a body owner is ignored); validation; an unknown dist
// is refused (a watch that can never be read would sit silent forever); a failed
// reading read lists the watches with reading null + readings_ok false, never a 0;
// DELETE is owner-scoped.

const h = vi.hoisted(() => {
  const s: { tables: Record<string, any>; calls: Array<[string, string, ...any[]]>; upserted: any } = { tables: {}, calls: [], upserted: null }
  const make = (table: string) => {
    const b: any = {
      select: (..._a: any[]) => b,
      eq: (...a: any[]) => { s.calls.push([table, "eq", ...a]); return b },
      in: () => b,
      order: () => b,
      limit: () => b,
      delete: () => { s.calls.push([table, "delete"]); return b },
      upsert: (row: any) => { s.upserted = row; return b },
      maybeSingle: async () => s.tables[`${table}:single`] ?? { data: null, error: null },
      then: (resolve: any) => resolve(s.tables[table] ?? { data: [], error: null }),
    }
    return b
  }
  return { s, sb: { from: (t: string) => make(t) } }
})
const auth: { user: any } = { user: null }
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: h.sb }))
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!auth.user) throw new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 })
    return auth.user
  },
}))

import { GET, POST, DELETE } from "@/app/api/alerts/pack-chase/route"

const post = (body: any) => new NextRequest("https://t/api/alerts/pack-chase", { method: "POST", body: JSON.stringify(body) })
const fresh = () => new Date(Date.now() - 3600_000).toISOString()

beforeEach(() => {
  auth.user = { id: "user-1" }
  h.s.tables = {}
  h.s.calls = []
  h.s.upserted = null
})

describe("/api/alerts/pack-chase", () => {
  it("401s signed out", async () => {
    auth.user = null
    expect((await GET()).status).toBe(401)
    expect((await POST(post({ dist_id: "8903", tier: "legendary" }))).status).toBe(401)
  })

  it("validates dist, tier and threshold", async () => {
    expect((await POST(post({ dist_id: "abc", tier: "legendary" }))).status).toBe(400)
    expect((await POST(post({ dist_id: "8903", tier: "common" }))).status).toBe(400)
    expect((await POST(post({ dist_id: "8903", tier: "rare", min_vs_launch: 0.5 }))).status).toBe(400)
  })

  it("refuses a dist with no live counts", async () => {
    h.s.tables["topshot_atlas_dists:single"] = { data: null, error: null }
    expect((await POST(post({ dist_id: "8903", tier: "legendary" }))).status).toBe(404)
  })

  it("saves with the SESSION owner, ignoring a body owner", async () => {
    h.s.tables["topshot_atlas_dists:single"] = { data: { dist_id: "8903", title: "Rookie Year Royalty Pack" }, error: null }
    h.s.tables["pack_chase_watches"] = { data: [{ id: "w1" }], error: null, count: 0 }
    const res = await POST(post({ dist_id: "8903", tier: "legendary", min_vs_launch: 3, owner_key: "attacker" }))
    expect(res.status).toBe(200)
    expect(h.s.upserted).toMatchObject({ owner_key: "user-1", dist_id: "8903", tier: "legendary", min_vs_launch: 3, armed: true })
  })

  // 2026-11-07 review: the cap counted every watch before an UPSERT that may only
  // update one, so a collector at 50 could not edit a watch they already had.
  it("at the cap, an EXISTING watch can still be edited; a NEW one is refused", async () => {
    h.s.tables["topshot_atlas_dists:single"] = { data: { dist_id: "8903", title: "Rookie Year Royalty Pack" }, error: null }
    h.s.tables["pack_chase_watches"] = { data: [{ id: "w1" }], error: null, count: 50 }
    expect((await POST(post({ dist_id: "8903", tier: "legendary", min_vs_launch: 5 }))).status).toBe(200)
    h.s.upserted = null
    h.s.tables["pack_chase_watches"] = { data: [], error: null, count: 50 }
    expect((await POST(post({ dist_id: "8904", tier: "legendary", min_vs_launch: 5 }))).status).toBe(409)
    expect(h.s.upserted).toBeNull()
  })

  it("a failed reading read lists watches with reading null and readings_ok false", async () => {
    h.s.tables["pack_chase_watches"] = { data: [{ id: "w1", dist_id: "8903", tier: "legendary", min_vs_launch: 2 }], error: null }
    h.s.tables["topshot_atlas_dists"] = { data: null, error: { message: "boom" } }
    const body = await (await GET()).json()
    expect(body.readings_ok).toBe(false)
    expect(body.watches[0].reading).toBeNull()
  })

  it("an ok read returns the current reading", async () => {
    h.s.tables["pack_chase_watches"] = { data: [{ id: "w1", dist_id: "8903", tier: "legendary", min_vs_launch: 2 }], error: null }
    h.s.tables["topshot_atlas_dists"] = { data: [{ dist_id: "8903", summary_fetched_at: fresh(), unopened_count: 18, total_pack_count: 719, remaining_by_tier: { legendary: "1", common: "53" }, original_by_tier: { legendary: "3", common: "2154" } }], error: null }
    h.s.tables["pack_table_rows"] = { data: [{ dist_id: "8903", observed_packs_opened: 600 }], error: null }
    const body = await (await GET()).json()
    expect(body.readings_ok).toBe(true)
    expect(body.watches[0].reading.per100Now).toBeCloseTo(100 / 18, 6)
  })

  it("DELETE is scoped to the session owner", async () => {
    h.s.tables["pack_chase_watches"] = { data: [{ id: "w1" }], error: null }
    const res = await DELETE(new NextRequest("https://t/api/alerts/pack-chase?id=w1", { method: "DELETE" }))
    expect(res.status).toBe(200)
    expect(h.s.calls).toContainEqual(["pack_chase_watches", "eq", "owner_key", "user-1"])
  })
})
