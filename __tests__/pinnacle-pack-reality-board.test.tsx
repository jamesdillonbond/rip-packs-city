import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

// 2026-11-23: Disney Pinnacle Pack Reality (get_pinnacle_pack_reality). Pins: an unknown value stays
// unknown (never $0 / never a ratio), a failed read is a 5xx / degraded page — never an empty board,
// and a non-payload body is a failure.

let rpcResult: { data: unknown; error: unknown } = { data: null, error: null }
vi.mock("@/lib/supabase", () => {
  const admin = { rpc: async () => rpcResult, from: () => { throw new Error("no table reads") } }
  return { supabaseAdmin: admin, supabase: admin }
})

import { shapePinnacleReality, valueToPriceRatio, num } from "@/lib/insights/pinnacle-pack-reality-board"
import { GET } from "@/app/api/public/insights/pinnacle-pack-reality/route"
import Page from "@/app/insights/pinnacle-pack-reality/page"

const drop = {
  drop_name: "Star Wars Halloween Vol.1", price_usd: 49.95, dist_ids: ["8891"], packs_opened: 414,
  first_open_at: "2026-10-09T16:00:50Z", last_open_at: "2026-10-09T16:40:11Z",
  n_at_open: 414, avg_value_at_open: 59.67, n_today: 414, avg_value_today: 39.83,
  median_value_today: 21, best_pull_today: 202.5, pct_today_at_or_above_price: 11.1,
}
const unknownDrop = { ...drop, drop_name: "Predator Vol.1", dist_ids: ["8909"], n_at_open: 0, avg_value_at_open: null }

beforeEach(() => { rpcResult = { data: null, error: null } })

describe("shape + ratio", () => {
  it("keeps NULLs null (no $0 at open for a late-priced drop)", () => {
    const p = shapePinnacleReality({ since: "x", min_opens: 25, drops: [unknownDrop] })
    expect(p.drops[0].avg_value_at_open).toBeNull()
    expect(num(null)).toBeNull()
    expect(num("")).toBeNull()
  })
  it("throws on a body that is not the function's shape", () => {
    expect(() => shapePinnacleReality(null)).toThrow()
    expect(() => shapePinnacleReality({ rows: [] })).toThrow()
  })
  it("ratio is null when either side is unknown", () => {
    expect(valueToPriceRatio({ avg_value_today: 39.83, price_usd: 49.95 })).toBe(0.8)
    expect(valueToPriceRatio({ avg_value_today: null, price_usd: 49.95 })).toBeNull()
    expect(valueToPriceRatio({ avg_value_today: 10, price_usd: null })).toBeNull()
  })
})

describe("GET /api/public/insights/pinnacle-pack-reality", () => {
  it("returns the drops", async () => {
    rpcResult = { data: { since: "2026-09-01", min_opens: 25, drops: [drop] }, error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.source).toBe("get_pinnacle_pack_reality")
  })
  it("a failed read is a 5xx, never an empty board", async () => {
    rpcResult = { data: null, error: { message: "timeout" } }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.rows).toBeUndefined()
  })
})

describe("page", () => {
  it("renders rows; an unknown 'at open' is an em-dash, not $0", async () => {
    rpcResult = { data: { since: "2026-09-01", min_opens: 25, drops: [drop, unknownDrop] }, error: null }
    const html = renderToStaticMarkup(await Page())
    expect(html).toContain("Star Wars Halloween Vol.1")
    expect(html).toContain("0.80×")
    expect(html).toContain("/disney-pinnacle/pack/dist/8909")
    expect(html).not.toContain("$0.00")
  })
  it("a failed read does not claim 'no drop'", async () => {
    rpcResult = { data: null, error: { message: "down" } }
    const html = renderToStaticMarkup(await Page())
    expect(html).not.toContain("No drop has")
  })
})
