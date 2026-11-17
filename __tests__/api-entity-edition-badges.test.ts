import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/entity/edition-badges — the player-page Badge filter's read.
// ⚠ The contract that matters: a FAILED read must be an error status, never
// `{ badges: {} }` — an empty map renders every edition as badge-less.
// ⚠ And it must stay a GET: proxy.ts opens /api/entity/* to signed-out readers
// for GET only (see the proxy-is-public-path row).

const rpc: { data: any; error: any; calls: any[] } = { data: null, error: null, calls: [] }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async (fn: string, args: any) => { rpc.calls.push({ fn, args }); return { data: rpc.data, error: rpc.error } } },
}))

import * as route from "@/app/api/entity/edition-badges/route"

const get = (qs: string) => route.GET(new Request(`https://t/api/entity/edition-badges?${qs}`))

beforeEach(() => {
  rpc.data = {}
  rpc.error = null
  rpc.calls = []
})

describe("GET /api/entity/edition-badges", () => {
  it("exports GET and no POST handler", () => {
    expect(typeof route.GET).toBe("function")
    expect((route as Record<string, unknown>).POST).toBeUndefined()
  })

  it("returns the RPC's slug → titles map, deduping the requested slugs", async () => {
    rpc.data = { "2:145": ["Top Shot Debut"], "224:8051::17": [] }
    const res = await get(`collection=nba-top-shot&slugs=${["2:145", "224:8051::17", "2:145"].map(encodeURIComponent).join(",")}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ badges: { "2:145": ["Top Shot Debut"], "224:8051::17": [] } })
    expect(rpc.calls).toHaveLength(1)
    expect(rpc.calls[0].fn).toBe("get_edition_badge_titles")
    expect(rpc.calls[0].args.p_route_slugs).toEqual(["2:145", "224:8051::17"])
  })

  it("a failed read is an error status, not an empty badge map", async () => {
    rpc.error = { message: "canceling statement due to statement timeout", code: "57014" }
    const res = await get("collection=nba-top-shot&slugs=2:145")
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).badges).toBeUndefined()
  })

  it("a result of the wrong shape is a 502, never an empty badge map (reviewed 2026-09-25)", async () => {
    for (const bad of [null, [], "x", 3]) {
      rpc.data = bad
      const res = await get("collection=nba-top-shot&slugs=2:145")
      expect(res.status).toBe(502)
      expect((await res.json()).badges).toBeUndefined()
    }
  })

  it("rejects an unknown collection, missing slugs, and too many slugs without calling the DB", async () => {
    expect((await get("collection=nope&slugs=a")).status).toBe(404)
    expect((await get("collection=nba-top-shot")).status).toBe(400)
    expect((await get(`collection=nba-top-shot&slugs=${Array.from({ length: 101 }, (_, i) => `s${i}`).join(",")}`)).status).toBe(400)
    expect(rpc.calls).toHaveLength(0)
  })
})
