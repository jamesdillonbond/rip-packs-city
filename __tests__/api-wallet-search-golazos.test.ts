import { describe, it, expect, beforeEach, vi } from "vitest"

// Golazos wallet analysis in POST /api/wallet-search. Golazos is served from
// wallet_moments_cache via the shared get_wallet_moments_with_fmv RPC +
// serverMomentToRow (the SAME source/mapper /api/collection-moments uses), NOT a
// live on-chain walk — the Cadence walk that fills wmc is owned by
// /api/wallet-backfill-golazos. Pins: the populated read maps RPC moments ->
// MomentRow rows with a correct summary; an empty wmc read returns rows:[] (and,
// with no INGEST token in test, never attempts the backfill fetch); an RPC error
// returns a soft 200 error; and an unresolvable username returns the resolve
// error. Also guards that the stale "coming soon" stub is gone.

const state = vi.hoisted(() => ({
  rpc: { data: null as unknown, error: null as { message?: string } | null },
  resolveFound: false,
}))

vi.mock("@/lib/cache", () => ({ getOrSetCache: (_k: string, _t: number, fn: () => unknown) => fn() }))
vi.mock("@/lib/chains/flow/flow", () => ({ default: { query: async () => [] } }))
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => ({}) }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => state.rpc },
}))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => {} }))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  resolveTopShotUsernameCacheAware: async () =>
    state.resolveFound ? { found: true, walletAddress: "0xc4ab4a06ade1fd0f" } : { found: false },
}))

import { POST } from "@/app/api/wallet-search/route"

const ADDR = "0xc4ab4a06ade1fd0f"
const req = (body: Record<string, unknown>): any => ({
  json: async () => body,
  url: "https://t/api/wallet-search",
})

// A ServerMoment as get_wallet_moments_with_fmv returns for Golazos (shape
// captured live 2026-08-09).
const moment = (over: Record<string, unknown> = {}) => ({
  moment_id: "1006747815",
  edition_key: "505",
  serial_number: 1,
  fmv_usd: 5,
  confidence: "STALE",
  low_ask: 2,
  player_name: "Diego Milito",
  set_name: "Estrellas",
  tier: "RARE",
  series_number: 1,
  circulation_count: 207,
  thumbnail_url: "https://assets.laligagolazos.com/x.png",
  team_name: "Real Zaragoza",
  acquired_at: null,
  last_seen_at: null,
  buy_price: null,
  acquisition_method: null,
  acquisition_source: null,
  acquisition_confidence: null,
  loan_principal: null,
  source_address: null,
  is_locked: false,
  ...over,
})

beforeEach(() => {
  state.rpc = { data: null, error: null }
  state.resolveFound = false
  delete process.env.INGEST_SECRET_TOKEN
})

describe("POST /api/wallet-search — Golazos wmc path", () => {
  it("maps wmc moments to MomentRow rows with a correct summary", async () => {
    state.rpc = {
      data: [
        {
          moments: [moment(), moment({ moment_id: "1023633856", player_name: "Willian José", fmv_usd: 24.5 })],
          total_count: 9400,
        },
      ],
      error: null,
    }
    const res = await POST(req({ input: ADDR, collection: "laliga-golazos", limit: 2, offset: 0 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error).toBeUndefined()
    expect(body.rows).toHaveLength(2)
    expect(body.rows[0].momentId).toBe("1006747815")
    expect(body.rows[0].playerName).toBe("Diego Milito")
    expect(body.rows[0].tier).toBe("RARE")
    expect(body.rows[0].fmv).toBe(5)
    expect(body.rows[0].serialNumber).toBe(1)
    expect(body.rows[0].lowAsk).toBe(2)
    expect(body.rows[0].editionKey).toBe("505")
    expect(body.rows[0].thumbnailUrl).toBe("https://assets.laligagolazos.com/x.png")
    expect(body.rows[1].playerName).toBe("Willian José")
    expect(body.walletAddress).toBe(ADDR)
    // total_count drives totalMoments; remaining accounts for the offset window.
    expect(body.summary).toEqual({ totalMoments: 9400, returnedMoments: 2, remainingMoments: 9398 })
  })

  it("computes remainingMoments from the offset window", async () => {
    state.rpc = { data: [{ moments: [moment()], total_count: 50 }], error: null }
    const res = await POST(req({ input: ADDR, collection: "laliga-golazos", limit: 1, offset: 10 }))
    const body = await res.json()
    // 50 total - offset 10 - 1 returned = 39 remaining.
    expect(body.summary).toEqual({ totalMoments: 50, returnedMoments: 1, remainingMoments: 39 })
  })

  it("returns rows:[] (no stale 'coming soon') on an empty wmc read", async () => {
    state.rpc = { data: [{ moments: [], total_count: 0 }], error: null }
    const res = await POST(req({ input: ADDR, collection: "laliga-golazos" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.summary.totalMoments).toBe(0)
    expect(JSON.stringify(body)).not.toContain("coming soon")
  })

  it("returns a soft 200 error (never a 5xx) when the wmc read fails", async () => {
    state.rpc = { data: null, error: { message: "boom" } }
    const res = await POST(req({ input: ADDR, collection: "laliga-golazos" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.error).toContain("Failed to fetch")
  })

  it("returns the resolve error for an unresolvable username", async () => {
    state.resolveFound = false
    const res = await POST(req({ input: "nosuchuser", collection: "laliga-golazos" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error).toContain("Could not resolve")
    expect(body.rows).toEqual([])
  })

  it("resolves a username via the shared resolver, then serves that wallet's wmc rows", async () => {
    state.resolveFound = true
    state.rpc = { data: [{ moments: [moment()], total_count: 1 }], error: null }
    const res = await POST(req({ input: "milito", collection: "laliga-golazos" }))
    const body = await res.json()
    expect(body.walletAddress).toBe("0xc4ab4a06ade1fd0f")
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].momentId).toBe("1006747815")
  })
})
