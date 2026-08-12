import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/candy-mlb — the gated Candy
// chain-two public board. Mocks @/lib/supabase's supabaseAdmin as a per-table
// thenable builder over candy_secondary_board + candy_pack_ev_model. Pins:
//   - the VALID_TIERS 400 guard,
//   - the happy path incl. the coverage-disclosure math (priced / with-offer /
//     rainbow priced+total) and echoed filters,
//   - the board-query-error -> 500 path,
//   - the pack-EV FAIL-SOFT contract: a pack_ev error omits the block but STILL
//     returns 200 with the board (the board is the primary payload).

const tables: Record<string, { data: any; error: any }> = {}

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    const payload = () => tables[table] ?? { data: [], error: null }
    const b: any = {
      select: () => b, eq: () => b, gte: () => b, gt: () => b, lte: () => b,
      lt: () => b, ilike: () => b, order: () => b, limit: () => b, in: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  const admin: any = { from: (t: string) => make(t), rpc: async () => ({ data: null, error: null }) }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/public/insights/candy-mlb/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/candy-mlb"

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/candy-mlb", () => {
  it("400s on an invalid tier (only COMMON/LEGENDARY allowed)", async () => {
    const res = await GET(req(`${base}?tier=rare`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("invalid tier")
  })

  it("returns rows + coverage math + echoed filters on the happy path", async () => {
    tables.candy_secondary_board = {
      data: [
        // priced common
        { external_id: "a", is_rainbow: false, fmv_usd: 5.7, best_offer_usd: 3.0 },
        // priced rainbow (drives rainbow_priced + rainbow_total)
        { external_id: "b", is_rainbow: true, fmv_usd: 170, best_offer_usd: null },
        // cold-tail: no fmv, no offer (must NOT be filtered out — honest picture)
        { external_id: "c", is_rainbow: false, fmv_usd: null, best_offer_usd: null },
      ],
      error: null,
    }
    tables.candy_pack_ev_model = {
      data: [{ typical_pull_ev_usd: 26, actual_ev_usd: 86, pack_cost_usd: 10 }],
      error: null,
    }
    const res = await GET(req(`${base}?tier=legendary&player=judge&rainbow=1&sort=offer&limit=50`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(3)
    expect(body.meta.total_rows).toBe(3)
    expect(body.meta.source).toBe("candy_secondary_board")
    // coverage disclosure math
    expect(body.meta.coverage.total_editions).toBe(3)
    expect(body.meta.coverage.priced_editions).toBe(2)
    expect(body.meta.coverage.editions_with_best_offer).toBe(1)
    expect(body.meta.coverage.rainbow_priced).toBe(1)
    expect(body.meta.coverage.rainbow_total).toBe(1)
    // pack-EV block present, leads with typical pull
    expect(body.meta.pack_ev).toMatchObject({ typical_pull_ev_usd: 26 })
    // filters echoed; sort resolves to the mapped column
    expect(body.meta.filters).toMatchObject({
      tier: "LEGENDARY", player: "judge", rainbow: true, sort: "best_offer_usd", limit: 50,
    })
  })

  it("defaults sort to fmv_usd and clamps limit into [1,300]", async () => {
    tables.candy_secondary_board = { data: [], error: null }
    const res = await GET(req(`${base}?sort=bogus&limit=99999`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.filters.sort).toBe("fmv_usd")
    expect(body.meta.filters.limit).toBe(300)
  })

  it("500s on a board query error", async () => {
    tables.candy_secondary_board = { data: null, error: { message: "board down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("board down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })

  it("fail-soft: a pack-EV error omits the block but still 200s with the board", async () => {
    tables.candy_secondary_board = { data: [{ external_id: "a", fmv_usd: 5 }], error: null }
    tables.candy_pack_ev_model = { data: null, error: { message: "ev view down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.pack_ev).toBeNull()
  })
})

// Public-contract hygiene (added 2026-07-27, pre-launch audit).
//
// Two defects this pins:
//  (a) the route shipped `confidence` on a PUBLIC contract while the board
//      itself refuses to render the pill (site-wide policy: FMV confidence is a
//      build-time signal). Transporting it only invites a consumer to render
//      what we won't;
//  (b) the coverage note hardcoded "every price is LOW-confidence off only 1–2
//      sales". By 2026-07-27 that was false on both counts — 24 of 109 priced
//      editions had reached MEDIUM and 43 of the LOW ones had 3+ sales. The
//      note is now computed from the payload so it cannot go stale again.
describe("/api/public/insights/candy-mlb — public contract hygiene", () => {
  it("never selects or returns FMV confidence", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("app/api/public/insights/candy-mlb/route.ts", "utf8"),
    )
    // Strip comment lines first — the block deliberately EXPLAINS why
    // confidence is excluded, so a naive substring match would fail on the
    // explanation rather than on a real regression.
    const cols = src
      .slice(src.indexOf("const COLS"), src.indexOf("const VALID_TIERS"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
    expect(cols).not.toContain("confidence")
  })

  it("states coverage from measured counts, not a hardcoded confidence claim", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("app/api/public/insights/candy-mlb/route.ts", "utf8"),
    )
    expect(src).not.toContain("every price is LOW-confidence")
    expect(src).toContain("median_sales_per_priced_edition")
  })
})
