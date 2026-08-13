import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep-drive of /api/wallet/pack-summary's UNCOVERED error legs — the shared
// api-wallet-reads suite pins 401 / 200 / 403, leaving the missing-wallet 400
// and the three 500 paths (verify-lookup error, RPC error, RPC throw) dark.
// Those are the silent-500 class: a DB fault must surface as a real 500 (the
// caller retries / shows an error), never as a false-empty summary that would
// read as "this wallet bought no packs."

const state = vi.hoisted(() => ({
  user: { id: "user-1" } as any,
  savedWallets: { data: [{ wallet_addr: "0xabc", verified_at: "2026-07-01" }], error: null } as any,
  rpcResult: { data: { totals: { primary_drops: 2 } }, error: null } as any,
  rpcThrows: false,
}))

vi.mock("@/lib/supabase", () => {
  const makeBuilder = () => {
    const b: any = {}
    for (const m of ["select", "eq", "not", "is", "limit", "order"]) b[m] = () => b
    b.then = (resolve: any) => resolve(state.savedWallets)
    return b
  }
  const client: any = {
    from: () => makeBuilder(),
    rpc: async () => {
      if (state.rpcThrows) throw new Error("connection reset")
      return state.rpcResult
    },
  }
  return { supabaseAdmin: client, supabase: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
}))

const { GET } = await import("@/app/api/wallet/pack-summary/route")
const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const URL_OK = "https://t/api/wallet/pack-summary?wallet=0xabc"

beforeEach(() => {
  state.user = { id: "user-1" }
  state.savedWallets = { data: [{ wallet_addr: "0xabc", verified_at: "2026-07-01" }], error: null }
  state.rpcResult = { data: { totals: { primary_drops: 2 } }, error: null }
  state.rpcThrows = false
})

describe("wallet/pack-summary — guards + error legs", () => {
  it("400s when the wallet param is missing", async () => {
    const res = await GET(req("https://t/api/wallet/pack-summary"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("500s (not false-empty) when the saved_wallets verify lookup errors", async () => {
    state.savedWallets = { data: null, error: { message: "lookup boom" } }
    const res = await GET(req(URL_OK))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("lookup boom")
  })

  it("403s when the wallet is not verified on the account", async () => {
    state.savedWallets = { data: [], error: null }
    const res = await GET(req(URL_OK))
    expect(res.status).toBe(403)
  })

  it("500s when get_wallet_pack_summary returns an error", async () => {
    state.rpcResult = { data: null, error: { message: "rpc boom" } }
    const res = await GET(req(URL_OK))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("rpc boom")
  })

  it("500s when the RPC throws unexpectedly", async () => {
    state.rpcThrows = true
    const res = await GET(req(URL_OK))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("connection reset")
  })

  it("200s with the summary + no-store cache header for a verified wallet", async () => {
    const res = await GET(req(URL_OK))
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toContain("no-store")
    expect((await res.json()).totals.primary_drops).toBe(2)
  })

  it("lowercases + trims the wallet before the ownership check", async () => {
    // Whitespace/upper wallet must still match the lowercased saved wallet.
    const res = await GET(req("https://t/api/wallet/pack-summary?wallet=%20%200xABC%20"))
    expect(res.status).toBe(200)
  })
})
