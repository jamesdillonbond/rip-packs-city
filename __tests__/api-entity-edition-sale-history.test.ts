import { describe, it, expect, beforeEach, vi } from "vitest"

// The `part=sale-history` arm of /api/entity/edition — the long-horizon price
// series built from actual sale prints.
//
// It is a separate part (not a wider `days` on fmv-history) because the two
// read different tables: fmv_snapshots only begins 2026-03-31, while `sales`
// goes back to 2020-07-28. The clamp is what makes "ALL" expressible, so it is
// pinned here: days must floor at 0 (the RPC's all-time sentinel) rather than
// at the 7 the fmv-history arm uses.

const calls: Array<{ fn: string; args: any }> = []
const rpc: { data: any; error: any } = { data: [], error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      calls.push({ fn, args })
      return { data: rpc.data, error: rpc.error }
    },
  },
  supabase: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/entity/edition/route"

const req = (qs: string) => new Request("https://t/api/entity/edition?" + qs)
const BASE = "collection=nba-top-shot&slug=5%3A145"

beforeEach(() => {
  calls.length = 0
  rpc.data = []
  rpc.error = null
})

describe("GET /api/entity/edition?part=sale-history", () => {
  it("calls get_edition_sale_history, not the FMV history RPC", async () => {
    const res = await GET(req(BASE + "&part=sale-history&days=365"))
    expect(res.status).toBe(200)
    expect(calls[0].fn).toBe("get_edition_sale_history")
    expect(calls[0].args).toMatchObject({ p_route_slug: "5:145", p_days: 365 })
  })

  it("passes days=0 through as the all-time sentinel", async () => {
    // The fmv-history arm floors at 7; if this arm reused that clamp, "ALL"
    // would silently become a one-week window.
    await GET(req(BASE + "&part=sale-history&days=0"))
    expect(calls[0].args.p_days).toBe(0)
  })

  it("defaults to a 1-year window when days is omitted", async () => {
    await GET(req(BASE + "&part=sale-history"))
    expect(calls[0].args.p_days).toBe(365)
  })

  it("clamps an absurd window to the 4000-day ceiling", async () => {
    await GET(req(BASE + "&part=sale-history&days=999999"))
    expect(calls[0].args.p_days).toBe(4000)
  })

  it("floors a negative window at 0 rather than passing it to the RPC", async () => {
    await GET(req(BASE + "&part=sale-history&days=-30"))
    expect(calls[0].args.p_days).toBe(0)
  })

  it("falls back to the floor for a non-numeric days", async () => {
    await GET(req(BASE + "&part=sale-history&days=abc"))
    expect(calls[0].args.p_days).toBe(0)
  })

  it("returns the bucket rows the RPC produced", async () => {
    rpc.data = [
      { bucket: "2020-07-01", median_usd: 20, low_usd: 20, high_usd: 20, sales_count: 1, grain: "month" },
      { bucket: "2020-08-01", median_usd: 45, low_usd: 30, high_usd: 80, sales_count: 11, grain: "month" },
    ]
    const res = await GET(req(BASE + "&part=sale-history&days=0"))
    const body = await res.json()
    expect(body).toHaveLength(2)
    expect(body[1]).toMatchObject({ median_usd: 45, grain: "month", sales_count: 11 })
  })

  it("returns [] rather than null when the RPC yields nothing", async () => {
    rpc.data = null
    const res = await GET(req(BASE + "&part=sale-history&days=0"))
    expect(await res.json()).toEqual([])
  })

  it("500s when the RPC errors", async () => {
    rpc.error = { message: "boom" }
    const res = await GET(req(BASE + "&part=sale-history&days=0"))
    expect(res.status).toBe(500)
  })

  it("still 404s an unknown collection and 400s a missing slug", async () => {
    expect((await GET(req("collection=nope&slug=x&part=sale-history"))).status).toBe(404)
    expect((await GET(req("collection=nba-top-shot&part=sale-history"))).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it("leaves the fmv-history arm on its own RPC and its own 7-day floor", async () => {
    await GET(req(BASE + "&part=fmv-history&days=0"))
    expect(calls[0].fn).toBe("get_edition_fmv_history")
    expect(calls[0].args.p_days).toBe(7)
  })

  it("400s an unknown part", async () => {
    expect((await GET(req(BASE + "&part=sale-histor"))).status).toBe(400)
  })
})
