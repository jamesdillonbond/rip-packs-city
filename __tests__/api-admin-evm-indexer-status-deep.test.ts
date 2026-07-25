import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of GET /api/admin/evm-indexer-status (the sibling only pins auth).
// Snapshots each ERC-721 contract's cursor position + lag from the sealed tip. Legs
// pinned: auth (bearer + ?token=), the contracts/cursor read errors → 500, the
// per-chain sealed-tip fetch (supported/unsupported/throw → null), and the
// cursor-present vs cursor-absent lag math.

const st = vi.hoisted(() => ({ contracts: { data: [] as any[] | null, error: null as any }, cursors: { data: [] as any[] | null, error: null as any }, tip: 2000 as number | null, tipThrows: false }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: any = { select: () => b, order: () => b, then: (r: any) => r(table === "evm_nft_contracts" ? st.contracts : st.cursors) }
      return b
    },
  },
}))
vi.mock("@/lib/evm-rpc", () => ({
  SUPPORTED_CHAIN_SLUGS: ["flow_evm_mainnet", "base_mainnet"],
  getBlockNumber: async () => { if (st.tipThrows) throw new Error("rpc down"); return st.tip },
}))

import { GET } from "@/app/api/admin/evm-indexer-status/route"

const get = (opts: { auth?: string; token?: string } = {}) =>
  ({ headers: new Headers(opts.auth ? { authorization: opts.auth } : {}), nextUrl: new URL(`https://t/api/admin/evm-indexer-status${opts.token ? `?token=${opts.token}` : ""}`) }) as any
const contract = (over: any = {}) => ({ chain_id: 8453, contract_address: "0xABC", label: "Beezie", start_block: 100, is_active: true, ...over })
const cursor = (over: any = {}) => ({ chain_id: 8453, contract_address: "0xabc", last_processed_block: 1900, last_advanced_at: "2026-07-01", total_transfers_indexed: 500, ...over })

beforeEach(() => {
  process.env.RPC_ADMIN_TOKEN = "adm"
  st.contracts = { data: [contract()], error: null }
  st.cursors = { data: [cursor()], error: null }
  st.tip = 2000
  st.tipThrows = false
})

describe("GET /api/admin/evm-indexer-status", () => {
  it("401 without a token", async () => {
    expect((await GET(get({ auth: "Bearer nope" }))).status).toBe(401)
  })
  it("accepts the token via ?token=", async () => {
    expect((await GET(get({ token: "adm" }))).status).toBe(200)
  })
  it("contracts read error → 500", async () => {
    st.contracts = { data: null, error: { message: "reg down" } }
    const res = await GET(get({ auth: "Bearer adm" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("registry_read_failed")
  })
  it("cursor read error → 500", async () => {
    st.cursors = { data: null, error: { message: "cursor down" } }
    const res = await GET(get({ auth: "Bearer adm" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("cursor_read_failed")
  })
  it("computes lag from the sealed tip and the cursor block", async () => {
    const body = await (await GET(get({ auth: "Bearer adm" }))).json()
    const c = body.contracts[0]
    expect(c.sealed_tip).toBe(2000)
    expect(c.cursor_block).toBe(1900)
    expect(c.lag_blocks).toBe(100) // 2000 - 1900
    expect(c.cursor_initialized).toBe(true)
    expect(c.total_transfers_indexed).toBe(500)
    expect(c.chain_slug).toBe("base_mainnet")
  })
  it("no cursor → cursor_block = start_block-1, lag from that", async () => {
    st.cursors = { data: [], error: null }
    const c = (await (await GET(get({ auth: "Bearer adm" }))).json()).contracts[0]
    expect(c.cursor_initialized).toBe(false)
    expect(c.cursor_block).toBe(99) // start_block 100 - 1
    expect(c.lag_blocks).toBe(1901)
    expect(c.total_transfers_indexed).toBe(0)
  })
  it("a sealed-tip fetch throw → sealed_tip null, lag null", async () => {
    st.tipThrows = true
    const c = (await (await GET(get({ auth: "Bearer adm" }))).json()).contracts[0]
    expect(c.sealed_tip).toBeNull()
    expect(c.lag_blocks).toBeNull()
  })
  it("an unsupported chain_id → chain_slug null, tip null", async () => {
    st.contracts = { data: [contract({ chain_id: 99999 })], error: null }
    const c = (await (await GET(get({ auth: "Bearer adm" }))).json()).contracts[0]
    expect(c.chain_slug).toBeNull()
    expect(c.sealed_tip).toBeNull()
  })
})
