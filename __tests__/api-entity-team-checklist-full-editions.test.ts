import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * /api/entity/team-checklist-full-editions — the "Full editions" checklist view.
 * The header is only correct over the WHOLE scoped list, so the route must
 * REFUSE a partial read (a failed page, or fewer distinct editions than the
 * progress total) and never publish a count / cost built from part of the list.
 */

let progressTotal = 3
let pages: Array<{ data: unknown; error: { message: string } | null }> = []
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
let probeRows: unknown[] = []

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      if (fn === "get_team_checklist_progress") return Promise.resolve({ data: { total: progressTotal, wallet_cached: true }, error: null })
      return Promise.resolve(pages.shift() ?? { data: [], error: null })
    },
    from: () => {
      const b: any = {
        select: () => b, eq: () => b, like: () => b,
        limit: () => Promise.resolve({ data: probeRows, error: null }),
      }
      return b
    },
  },
}))

import { GET } from "@/app/api/entity/team-checklist-full-editions/route"

const req = (q: string) => new Request(`https://t/api/entity/team-checklist-full-editions?${q}`)
const W = "0x0123456789abcdef"

beforeEach(() => { rpcCalls.length = 0; pages = []; progressTotal = 3; probeRows = [] })

describe("GET /api/entity/team-checklist-full-editions", () => {
  it("removes parallels from view but counts them: owning only a parallel checks off its full edition; a missing edition costs its cheapest version", async () => {
    progressTotal = 5
    pages = [{ data: [
      { route_slug: "1:1", floor_usd: 10, owned: false },
      { route_slug: "1:1::2", floor_usd: 4, owned: true, owned_count: 1 },
      { route_slug: "1:2", floor_usd: 20, owned: false },
      { route_slug: "1:2::3", floor_usd: 15, owned: false },
      { route_slug: "1:3", floor_usd: 30, owned: true, owned_count: 1 },
    ], error: null }]
    const r = await GET(req(`collection=nba-top-shot&slug=detroit-pistons&wallet=${W}`))
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.has_parallels).toBe(true)
    expect(j.progress.total).toBe(3)
    expect(j.progress.owned).toBe(2)
    expect(j.progress.cost_to_complete_usd).toBe(15)
    expect(j.progress.wallet_cached).toBe(true)
    expect(j.editions.map((e: { route_slug: string }) => e.route_slug).sort()).toEqual(["1:1", "1:2", "1:3"])
  })

  it("REFUSES a read shorter than the progress total — no editions, no cost", async () => {
    progressTotal = 5
    pages = [{ data: [{ route_slug: "1:1", floor_usd: 10 }], error: null }]
    const r = await GET(req(`collection=nba-top-shot&slug=detroit-pistons`))
    expect(r.status).toBeGreaterThanOrEqual(500)
    const j = await r.json()
    expect(j.editions).toBeUndefined()
    expect(j.progress).toBeUndefined()
  })

  it("REFUSES when a later page fails, rather than summing the first page", async () => {
    progressTotal = 250
    pages = [
      { data: Array.from({ length: 200 }, (_, i) => ({ route_slug: `1:${i}` })), error: null },
      { data: null, error: { message: "canceling statement due to statement timeout" } },
    ]
    const r = await GET(req(`collection=nba-top-shot&slug=detroit-pistons`))
    expect(r.status).toBeGreaterThanOrEqual(500)
    expect((await r.json()).editions).toBeUndefined()
    expect(rpcCalls.filter((c) => c.fn === "get_team_checklist").map((c) => c.args.p_offset)).toEqual([0, 200])
  })

  it("the probe answers from the data: parallels present or absent", async () => {
    probeRows = [{ external_id: "1:1::2" }]
    expect(await (await GET(req("collection=nba-top-shot&probe=1"))).json()).toEqual({ has_parallels: true })
    probeRows = []
    expect(await (await GET(req("collection=nfl-all-day&probe=1"))).json()).toEqual({ has_parallels: false })
    expect(rpcCalls).toHaveLength(0)
  })

  it("rejects an unknown collection", async () => {
    expect((await GET(req("collection=nope&slug=x"))).status).toBe(404)
  })
})
