import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/wallets/resolve-usernames.
// Filters addrs against the Flow-address regex and short-circuits with
// { usernames: {} } (200) before the RPC when none are valid. Otherwise wraps
// analytics_resolve_usernames. Pins the no-valid-addr short-circuit, the happy
// map path, and the rpc-error 500.

const rpc: { data: any; error: any } = { data: null, error: null }
let rpcCalls = 0

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => { rpcCalls++; return { data: rpc.data, error: rpc.error } },
  },
}))

import { GET } from "@/app/api/analytics/wallets/resolve-usernames/route"

const req = (url = "https://t/api/analytics/wallets/resolve-usernames") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpcCalls = 0 })

describe("GET /api/analytics/wallets/resolve-usernames", () => {
  it("short-circuits with an empty map when no valid addresses are given", async () => {
    const res = await GET(req("https://t/api/analytics/wallets/resolve-usernames?addrs=garbage"))
    expect(res.status).toBe(200)
    expect((await res.json()).usernames).toEqual({})
    expect(rpcCalls).toBe(0) // guard returns before the RPC
  })

  it("returns the resolved username map for valid addresses", async () => {
    rpc.data = { "0xbd94cade097e50ac": "trevor" }
    const res = await GET(req("https://t/api/analytics/wallets/resolve-usernames?addrs=0xbd94cade097e50ac"))
    expect(res.status).toBe(200)
    expect((await res.json()).usernames).toEqual({ "0xbd94cade097e50ac": "trevor" })
    expect(rpcCalls).toBe(1)
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req("https://t/api/analytics/wallets/resolve-usernames?addrs=0xbd94cade097e50ac"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("resolve_usernames_failed")
  })
})
