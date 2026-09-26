import { describe, it, expect, beforeEach, vi } from "vitest"

// POST /api/entity/edition-badges — the player-page Badge filter's read.
// ⚠ The contract that matters: a FAILED read must be an error status, never
// `{ badges: {} }` — an empty map renders every edition as badge-less.

const rpc: { data: any; error: any; calls: any[] } = { data: null, error: null, calls: [] }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async (fn: string, args: any) => { rpc.calls.push({ fn, args }); return { data: rpc.data, error: rpc.error } } },
}))

import { POST } from "@/app/api/entity/edition-badges/route"

const post = (body: unknown) =>
  POST(new Request("https://t/api/entity/edition-badges", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }))

beforeEach(() => {
  rpc.data = {}
  rpc.error = null
  rpc.calls = []
})

describe("POST /api/entity/edition-badges", () => {
  it("returns the RPC's slug → titles map, deduping the requested slugs", async () => {
    rpc.data = { "2:145": ["Top Shot Debut"], "2:218": [] }
    const res = await post({ collection: "nba-top-shot", slugs: ["2:145", "2:218", "2:145"] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ badges: { "2:145": ["Top Shot Debut"], "2:218": [] } })
    expect(rpc.calls).toHaveLength(1)
    expect(rpc.calls[0].fn).toBe("get_edition_badge_titles")
    expect(rpc.calls[0].args.p_route_slugs).toEqual(["2:145", "2:218"])
  })

  it("a failed read is an error status, not an empty badge map", async () => {
    rpc.error = { message: "canceling statement due to statement timeout", code: "57014" }
    const res = await post({ collection: "nba-top-shot", slugs: ["2:145"] })
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.badges).toBeUndefined()
  })

  it("rejects an unknown collection, a bad body, and too many slugs without calling the DB", async () => {
    expect((await post({ collection: "nope", slugs: ["a"] })).status).toBe(404)
    expect((await post({ collection: "nba-top-shot", slugs: "a" })).status).toBe(400)
    expect((await post("{not json")).status).toBe(400)
    expect((await post({ collection: "nba-top-shot", slugs: Array.from({ length: 501 }, (_, i) => `s${i}`) })).status).toBe(400)
    expect(rpc.calls).toHaveLength(0)
  })
})
