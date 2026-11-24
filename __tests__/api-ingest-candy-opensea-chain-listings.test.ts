import { describe, it, expect, vi, beforeEach } from "vitest"

// /api/ingest/candy-opensea-chain-listings — Candy OpenSea asks read key-free from the Solana chain (2026-11-23).

const state = { result: null as any, throws: null as string | null, logged: [] as any[], heartbeats: 0, prevExtra: { accounts: 13_398 } as any, opts: null as any }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_n: string, a: any) => { state.logged.push(a); return { error: null } },
    from: () => {
      const q: any = { select: () => q, eq: () => q, not: () => q, order: () => q, limit: async () => ({ data: [{ extra: state.prevExtra }], error: null }) }
      return q
    },
  },
}))
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: async () => { state.heartbeats++ } }))
vi.mock("@/lib/chains/solana/normalize", () => ({ CANDY_MLB_SLUG: "candy_mlb" }))
vi.mock("@/lib/chains/solana/das", () => ({ solUsd: async () => 200 }))
vi.mock("@/lib/candy/opensea-chain-listings", () => ({
  runOpenSeaChainListings: async (_db: unknown, opts: unknown) => {
    state.opts = opts
    if (state.throws) throw new Error(state.throws)
    return state.result
  },
}))

import { GET } from "@/app/api/ingest/candy-opensea-chain-listings/route"

const req = (auth?: string) => ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as any
const AUTH = "Bearer cron-secret-for-test-000000000000"
const base = { ok: true, error: null, accounts: 13_398, candy_matched: 2_153, written: 1_245, retired: 12, retire_skipped: null }

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret-for-test-000000000000"
  Object.assign(state, { result: base, throws: null, logged: [], heartbeats: 0, prevExtra: { accounts: 13_398 }, opts: null })
})

describe("/api/ingest/candy-opensea-chain-listings", () => {
  it("401s without the cron bearer, before any work", async () => {
    expect((await GET(req())).status).toBe(401)
    expect(state.heartbeats).toBe(0)
  })

  it("heartbeats, passes the last run's census size as the plausibility floor, and logs rows_written as asks landed", async () => {
    const res = await GET(req(AUTH))
    expect(res.status).toBe(200)
    expect(state.heartbeats).toBe(1)
    expect(state.opts.previousAccounts).toBe(13_398)
    expect(state.logged[0]).toMatchObject({ p_pipeline: "candy-opensea-chain-listings", p_ok: true, p_rows_found: 2_153, p_rows_written: 1_245 })
  })

  it("no readable previous run → NULL floor, never a made-up one", async () => {
    state.prevExtra = {}
    await GET(req(AUTH))
    expect(state.opts.previousAccounts).toBeNull()
  })

  it("a thrown run (RPC down) is logged NOT ok with NULL counts — never as a clean zero", async () => {
    state.throws = "getProgramAccounts HTTP 429"
    const res = await GET(req(AUTH))
    expect(res.status).toBe(500)
    expect(state.logged[0]).toMatchObject({ p_ok: false, p_rows_found: null, p_rows_written: null, p_error: "getProgramAccounts HTTP 429" })
  })
})
