import { describe, it, expect, vi, beforeEach } from "vitest"

// POST /api/candy/wallet-refresh — the anon live read behind a pasted Candy Wallet address.

const state = { result: null as any, throws: false, calls: 0, ready: true, logged: [] as any[] }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async (_n: string, args: any) => { state.logged.push(args); return { data: null, error: null } } },
}))
vi.mock("@/lib/candy/refresh-wallet", () => ({
  refreshCandyWallet: async (_db: any, wallet: string, opts: any) => {
    state.calls++
    if (state.throws) throw new Error("boom")
    return { ...state.result, _wallet: wallet, _opts: opts }
  },
}))
vi.mock("@/lib/chains/solana/normalize", () => ({ candyDiscoveryReady: () => state.ready, CANDY_MLB_SLUG: "candy_mlb" }))

import { POST } from "@/app/api/candy/wallet-refresh/route"

const okResult = {
  complete: true, found: 12, written: 12, retired: 2, ghosts_purged: 1, retire_error: null,
  walk_error: null, write_errors: [], escrow_listed_error: null,
}
let ip = 0
const req = (body: any, headers: Record<string, string> = {}) =>
  ({ headers: new Headers({ "x-forwarded-for": `10.0.0.${++ip}`, ...headers }), json: async () => body }) as any
// Distinct valid base58 wallets so the per-wallet cooldown does not couple tests.
// Base58 has no 0, O, I or l — build the varying tail from the alphabet itself.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const wallet = (n: number) => "9" + "A".repeat(41) + B58[Math.floor(n / B58.length) % B58.length] + B58[n % B58.length]

beforeEach(() => {
  state.result = okResult
  state.throws = false
  state.calls = 0
  state.ready = true
  state.logged = []
})

describe("POST /api/candy/wallet-refresh", () => {
  it("400s a Flow address without walking — a Candy key is base58, never 0x", async () => {
    const res = await POST(req({ wallet: "0x0b2a3299cc857e29" }))
    expect(res.status).toBe(400)
    expect(state.calls).toBe(0)
  })

  it("walks the wallet VERBATIM (case kept) with retirement on, and reports completeness", async () => {
    const w = "99UgF7Tt4HPDpJ7mK63kvucts21mhymgWkzu1EjsLjAy"
    const res = await POST(req({ wallet: "  " + w + " " }))
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j).toMatchObject({ ok: true, complete: true, found: 12, retired: 2 })
    expect(state.calls).toBe(1)
    expect(state.logged[0].p_extra.wallet).toBe(w)
    expect(state.logged[0].p_ok).toBe(true)
  })

  it("an incomplete walk answers complete:false (the tab then says it is showing the daily read) and logs ok:false", async () => {
    state.result = { ...okResult, complete: false, retired: null, walk_error: "DAS HTTP 502" }
    const res = await POST(req({ wallet: wallet(1) }))
    const j = await res.json()
    expect(j.complete).toBe(false)
    expect(state.logged[0].p_ok).toBe(false)
    expect(state.logged[0].p_error).toMatch(/502/)
  })

  it("a second search of the same wallet within the cooldown does not re-walk", async () => {
    const w = wallet(2)
    await POST(req({ wallet: w }))
    const res = await POST(req({ wallet: w }))
    expect((await res.json()).skipped).toBe("fresh")
    expect(state.calls).toBe(1)
  })

  it("an incomplete walk does NOT start the cooldown — the reader can retry", async () => {
    state.result = { ...okResult, complete: false }
    const w = wallet(3)
    await POST(req({ wallet: w }))
    await POST(req({ wallet: w }))
    expect(state.calls).toBe(2)
  })

  it("rate-limits one client", async () => {
    const h = { "x-forwarded-for": "203.0.113.9" }
    let last: any
    for (let i = 0; i < 7; i++) last = await POST(req({ wallet: wallet(10 + i) }, h))
    expect(last.status).toBe(429)
  })

  it("a walk that throws is a 503, never an empty answer", async () => {
    state.throws = true
    const res = await POST(req({ wallet: wallet(4) }))
    expect(res.status).toBe(503)
  })
})
