import { describe, it, expect, beforeEach, vi } from "vitest"

// 2026-11-14 (Sets review): the All Day / UFC / Pinnacle set-progress routes
// matched ?wallet= raw against `wallet_address = lower(p_wallet)`. A USERNAME or
// an un-prefixed hex address matched nothing, and a valid address RPC never
// walked also owned nothing: both answered "0% of every set". The shared gate
// (lib/sets/set-progress-wallet.ts) resolves the input and refuses an unwalked
// wallet. Driven end-to-end through the UFC route (its RPC is mocked).

const st = vi.hoisted(() => ({
  rpcArgs: [] as unknown[],
  sets: [] as unknown[],
  index: { ok: true, indexed: true } as { ok: boolean; indexed?: boolean; error?: unknown },
  resolve: { found: true, walletAddress: "0x00000000000000AA" } as Record<string, unknown>,
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_name: string, args: unknown) => { st.rpcArgs.push(args); return { data: { sets: st.sets }, error: null } },
  },
}))
vi.mock("@/lib/wallet-indexed", () => ({ walletIndexState: async () => st.index }))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  resolveTopShotUsernameCacheAware: async () => st.resolve,
}))

import { GET } from "@/app/api/ufc-set-progress/route"
const req = (w: string) => ({ nextUrl: new URL(`https://t/api/ufc-set-progress?wallet=${encodeURIComponent(w)}`) }) as never
const ZERO = [{ setId: "s1", setName: "S", ownedPlays: 0, totalPlays: 5, missingPlays: 5, completionPct: 0 }]
const SOME = [{ setId: "s1", setName: "S", ownedPlays: 2, totalPlays: 5, missingPlays: 3, completionPct: 40 }]

beforeEach(() => {
  st.rpcArgs.length = 0
  st.sets = SOME
  st.index = { ok: true, indexed: true }
  st.resolve = { found: true, walletAddress: "0x00000000000000AA" }
})

describe("set-progress wallet gate", () => {
  it("a USERNAME is resolved to its wallet before the RPC — never passed raw", async () => {
    const res = await GET(req("somecollector"))
    expect(res.status).toBe(200)
    expect(st.rpcArgs[0]).toEqual({ p_wallet: "0x00000000000000aa" })
  })
  it("an un-prefixed hex address is folded to its 0x form", async () => {
    await GET(req("00000000000000BB"))
    expect(st.rpcArgs[0]).toEqual({ p_wallet: "0x00000000000000bb" })
  })
  it("an unknown username is a 404, never 0% of every set", async () => {
    st.resolve = { found: false, reason: "username_not_found_on_topshot" }
    const res = await GET(req("nobody"))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe("wallet_not_found")
    expect(body.sets).toBeUndefined()
    expect(st.rpcArgs).toHaveLength(0)
  })
  it("a failed username LOOKUP is an error, not 'not found'", async () => {
    st.resolve = { found: false, reason: "topshot_gql_error", detail: "down" }
    const res = await GET(req("somecollector"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).code).not.toBe("wallet_not_found")
  })
  it("a wallet RPC never walked gets 409 wallet_not_indexed, not 0% of every set", async () => {
    st.sets = ZERO
    st.index = { ok: true, indexed: false }
    const res = await GET(req("0x0000000000000abc"))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("wallet_not_indexed")
    expect(body.sets).toBeUndefined()
  })
  it("a failed index check is an error, never 'not indexed' and never 0%", async () => {
    st.sets = ZERO
    st.index = { ok: false, error: new Error("boom") }
    const res = await GET(req("0x0000000000000abc"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).sets).toBeUndefined()
  })
  it("CONTROL: an indexed wallet owning none of the collection still answers 0%", async () => {
    st.sets = ZERO
    const res = await GET(req("0x0000000000000abc"))
    expect(res.status).toBe(200)
    expect((await res.json()).sets[0].completionPct).toBe(0)
  })
})
