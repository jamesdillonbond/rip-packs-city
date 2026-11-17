// __tests__/api-entity-panini-team-editions.test.ts
// The franchise hub's Panini "Load more" (2026-10-22): validates its inputs,
// forwards the hub's league + short slug, and a failed read is an error — never
// a 200 with [] (that would read as "no more cards").

import { beforeEach, describe, expect, it, vi } from "vitest"

const state: { res: { data: unknown; error: { message: string } | null }; calls: Array<[string, Record<string, unknown>]> } = {
  res: { data: [], error: null },
  calls: [],
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async (fn: string, args: Record<string, unknown>) => { state.calls.push([fn, args]); return state.res } },
}))

import { GET } from "@/app/api/entity/panini-team-editions/route"

const req = (qs: string) => new Request("http://localhost/api/entity/panini-team-editions" + qs)

beforeEach(() => {
  state.res = { data: [], error: null }
  state.calls = []
})

describe("GET /api/entity/panini-team-editions", () => {
  it("pages get_panini_franchise_editions by the hub's league + short slug", async () => {
    state.res = { data: [{ route_slug: "packcard-1" }], error: null }
    const res = await GET(req("?league=nba&team=blazers&offset=6&limit=6"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ route_slug: "packcard-1" }])
    expect(state.calls).toEqual([["get_panini_franchise_editions", { p_league: "NBA", p_team_slug: "blazers", p_limit: 6, p_offset: 6 }]])
  })
  it("rejects an unknown league and a malformed team without reading", async () => {
    expect((await GET(req("?league=xyz&team=blazers"))).status).toBe(404)
    expect((await GET(req("?league=nba&team=bad%20slug"))).status).toBe(400)
    expect(state.calls).toHaveLength(0)
  })
  it("a failed read is an error, never 200 []", async () => {
    state.res = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await GET(req("?league=nba&team=blazers"))
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})
