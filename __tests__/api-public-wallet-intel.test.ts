import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/wallet-intel. Constructs a module-level
// service-role client via @supabase/supabase-js createClient and wraps the
// get_wallet_intel_summary RPC. Pins the pre-DB Flow-address guard (400), the
// happy path, and the rpc-error → 500 (with the generic client-facing message).

const state: { data: any; error: any; tables: Record<string, { data: any; error: any }>; reads: string[] } = {
  data: null,
  error: null,
  tables: {},
  reads: [],
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async () => ({ data: state.data, error: state.error }),
    // lib/wallet-indexed.ts existence reads: .from(t).select().eq().limit()
    from: (t: string) => ({
      select: () => ({
        eq: (_c: string, v: string) => ({
          limit: async () => {
            state.reads.push(`${t}:${v}`)
            return state.tables[t] ?? { data: [], error: null }
          },
        }),
      }),
    }),
  }),
}))

import { GET } from "@/app/api/public/wallet-intel/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/wallet-intel"

beforeEach(() => {
  state.data = null
  state.error = null
  state.tables = { wallet_moments_cache: { data: [{ wallet_address: "x" }], error: null } }
  state.reads = []
})

describe("GET /api/public/wallet-intel", () => {
  it("400s when wallet is missing", async () => {
    const res = await GET(req(BASE))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Flow address")
  })

  it("400s when wallet is not a Flow address", async () => {
    const res = await GET(req(`${BASE}?wallet=0xabc`))
    expect(res.status).toBe(400)
  })

  it("returns the intel object on the happy path", async () => {
    state.data = { rookie_count: 3, trophy_count: 1, highlights: [] }
    const res = await GET(req(`${BASE}?wallet=0xbd94cade097e50ac`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ rookie_count: 3, trophy_count: 1, highlights: [], indexed: true })
  })

  // #237 (2026-11-08): three states, never two.
  const ZEROS = { wallet: "0xbd94cade097e50ac", ts_moments: 0, ts_fmv: 0, rookie_count: 0, trophy_count: 0, squeezed_count: 0, highlights: [] }

  it("⚠ a wallet RPC never walked is indexed:false with NULL figures, not a complete object of zeros", async () => {
    state.data = ZEROS
    state.tables = {}
    const res = await GET(req(`${BASE}?wallet=0xBD94CADE097E50AC`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.indexed).toBe(false)
    for (const k of ["ts_moments", "ts_fmv", "rookie_count", "trophy_count", "squeezed_count"]) expect(body[k]).toBeNull()
    expect(body.wallet).toBe("0xbd94cade097e50ac")
    // both kinds of evidence were consulted, on the normalised address
    expect(state.reads).toEqual(["wallet_moments_cache:0xbd94cade097e50ac", "wmc_clean_walks:0xbd94cade097e50ac"])
  })

  it("a wallet walked clean that holds nothing keeps its measured zeros (indexed:true)", async () => {
    state.data = ZEROS
    state.tables = { wmc_clean_walks: { data: [{ wallet_address: "0xbd94cade097e50ac" }], error: null } }
    const body = await (await GET(req(`${BASE}?wallet=0xbd94cade097e50ac`))).json()
    expect(body.indexed).toBe(true)
    expect(body.ts_moments).toBe(0)
  })

  it("⚠ a failed index-state read is a 503, not a claim either way", async () => {
    state.data = ZEROS
    state.tables = { wallet_moments_cache: { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } } }
    const res = await GET(req(`${BASE}?wallet=0xbd94cade097e50ac`))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.indexed).toBeUndefined()
    expect(body.ts_moments).toBeUndefined()
  })

  it("a wallet with moments pays no index read", async () => {
    state.data = { ...ZEROS, ts_moments: 12 }
    const body = await (await GET(req(`${BASE}?wallet=0xbd94cade097e50ac`))).json()
    expect(body.indexed).toBe(true)
    expect(state.reads).toEqual([])
  })

  it("500s with a generic message on an RPC error", async () => {
    state.error = { message: "internal rpc detail" }
    const res = await GET(req(`${BASE}?wallet=0xbd94cade097e50ac`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Failed to fetch wallet intel")
  })
})
