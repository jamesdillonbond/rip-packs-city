import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/wallet-summary — get_wallet_summary RPC wrapper. Pin the wallet guard,
// the RPC passthrough, the error → 500 path, and (2026-09-06) the USERNAME
// path: the RPC takes an address, the front door tells readers to paste a
// username, and the mismatch published "$0 · 0 unlocked · 0 locked" for a
// 15,284-Moment wallet under HTTP 200. A username now resolves through the
// cached ladder; an unresolved one is a 404, never a row of zeros.

const rpc: { data: any; error: any; lastArgs: any } = { data: null, error: null, lastArgs: null }
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async (_n: string, args: any) => { rpc.lastArgs = args; return { data: rpc.data, error: rpc.error } } }),
}))
const resolver = { result: null as string | null, calls: [] as string[] }
vi.mock("@/lib/chains/flow/topshot-username-resolve", async (orig) => {
  const real = await orig<typeof import("@/lib/chains/flow/topshot-username-resolve")>()
  return {
    ...real,
    lookupCachedTopShotUsername: async (_c: unknown, u: string) => { resolver.calls.push(u); return resolver.result },
  }
})

import { GET } from "@/app/api/wallet-summary/route"
const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.lastArgs = null; resolver.result = null; resolver.calls = [] })

describe("GET /api/wallet-summary", () => {
  it("400s without a wallet", async () => {
    expect((await GET(req("https://t/api/wallet-summary"))).status).toBe(400)
  })
  it("returns the RPC data on success and names the address it read", async () => {
    rpc.data = { totalMoments: 5 }
    const res = await GET(req("https://t/api/wallet-summary?wallet=0xb5081692483c2336"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ totalMoments: 5, resolved_wallet: "0xb5081692483c2336" })
    expect(resolver.calls).toEqual([]) // an address never hits the resolver
    expect(rpc.lastArgs.p_wallet).toBe("0xb5081692483c2336")
  })
  it("500s on an RPC error", async () => {
    rpc.error = { message: "nope" }
    const res = await GET(req("https://t/api/wallet-summary?wallet=0xb5081692483c2336"))
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("nope")
  })

  // ⛔ 2026-09-19 — A CANDY WALLET WENT TO THE TOP SHOT USERNAME LADDER. The
  // is-this-an-address test was the FLOW shape alone, so a Solana base58 wallet
  // was treated as a username, missed, and the route answered 404 with *"That
  // Top Shot username is not in our index yet — try the 0x wallet address."* —
  // to a reader who had pasted an address, about a collection Top Shot does not
  // index. The RPC behind it already worked: called with that exact wallet,
  // get_wallet_moments_with_fmv returned 5 moments and get_wallet_total_fmv
  // $12.04.
  it("treats a base58 (Solana/Candy) wallet as an ADDRESS, not a username", async () => {
    const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
    rpc.data = { total_moments: 5 }
    const res = await GET(req(
      `https://t/api/wallet-summary?wallet=${CANDY}&collection_id=209ade70-32c5-4470-bc7c-4793d660f713`
    ))
    expect(res.status).toBe(200)
    expect(resolver.calls, "a base58 address must never reach the username ladder").toEqual([])
    // ⛔ Passed through VERBATIM — base58 is case-sensitive.
    expect(rpc.lastArgs.p_wallet).toBe(CANDY)
    expect(rpc.lastArgs.p_collection_id).toBe("209ade70-32c5-4470-bc7c-4793d660f713")
  })

  // ⛔ 2026-09-25 — a Flow address against Candy MLB answered 200 with a complete
  // object of zeros ("0 moments · $0") about a wallet that cannot hold Candy at
  // all. The chain is the registry's; the wrong chain is refused, not answered.
  it("refuses a Flow address against a Solana collection (chain_mismatch 400), never a row of zeros", async () => {
    rpc.data = { total_moments: 0, wallet_fmv: 0 }
    const res = await GET(req(
      "https://t/api/wallet-summary?wallet=0xbd94cade097e50ac&collection_id=209ade70-32c5-4470-bc7c-4793d660f713"
    ))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("chain_mismatch")
    expect(body.message).toMatch(/Candy MLB lives on Solana/)
    expect(body.total_moments).toBeUndefined()
    expect(rpc.lastArgs, "the RPC must not be asked").toBeFalsy()
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  it("refuses a Solana address against Top Shot the same way", async () => {
    const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
    const res = await GET(req(`https://t/api/wallet-summary?wallet=${CANDY}&collection_id=95f28a17-224a-4025-96ad-adf8a4c63bfd`))
    expect(res.status).toBe(400)
    expect((await res.json()).message).toMatch(/NBA Top Shot lives on Flow/)
  })

  it("no-change control: a genuine username still goes to the ladder", async () => {
    // Widening the address test must not swallow usernames — if it did, every
    // username would be handed to the RPC as if it were an address and come
    // back as a row of zeros, the exact defect this file was written for.
    resolver.result = "0xb5081692483c2336"
    rpc.data = { total_moments: 1 }
    const res = await GET(req("https://t/api/wallet-summary?wallet=trevor"))
    expect(res.status).toBe(200)
    expect(resolver.calls).toEqual(["trevor"])
  })

  it("resolves a Top Shot username to its address BEFORE calling the RPC", async () => {
    resolver.result = "0xb5081692483c2336"
    rpc.data = { total_moments: 15284, wallet_fmv: 28480.29 }
    const res = await GET(req("https://t/api/wallet-summary?wallet=jamesdillonbond&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect(resolver.calls).toEqual(["jamesdillonbond"])
    expect(rpc.lastArgs.p_wallet).toBe("0xb5081692483c2336")
    expect(await res.json()).toMatchObject({ total_moments: 15284, resolved_wallet: "0xb5081692483c2336" })
  })

  it("an unresolved username is a 404 — the RPC is never asked, so zeros can never be published", async () => {
    resolver.result = null
    rpc.data = { total_moments: 0, wallet_fmv: 0, unlocked_fmv: 0, locked_fmv: 0 }
    const res = await GET(req("https://t/api/wallet-summary?wallet=nobody-here"))
    expect(res.status).toBe(404)
    expect(rpc.lastArgs).toBeNull()
    const body = await res.json()
    expect(body.error).toBe("unresolved")
    expect(body).not.toHaveProperty("wallet_fmv")
  })
})

// 2026-09-24 — a chain with no locking concept publishes no lock state.
describe("GET /api/wallet-summary — lock tiles on a chain without locking", () => {
  it("NULLs the lock fields for Candy MLB (Solana) so the tiles read n/a, not $0 · 0 locked", async () => {
    const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
    rpc.data = { total_moments: 338, wallet_fmv: 4286.94, locked_fmv: 0, locked_count: 0, unlocked_fmv: 0, unlocked_count: 0, lock_unknown_fmv: 4286.94, lock_unknown_count: 338 }
    const res = await GET(req(`https://t/api/wallet-summary?wallet=${CANDY}&collection_id=209ade70-32c5-4470-bc7c-4793d660f713`))
    const body = await res.json()
    expect(body.wallet_fmv).toBe(4286.94)
    for (const k of ["locked_fmv", "locked_count", "unlocked_fmv", "unlocked_count", "lock_unknown_fmv", "lock_unknown_count"]) {
      expect(body[k], k).toBeNull()
    }
  })
  it("no-change control: a Flow collection keeps its lock state", async () => {
    rpc.data = { total_moments: 5, locked_fmv: 12, locked_count: 1, unlocked_fmv: 3, unlocked_count: 4 }
    const res = await GET(req(`https://t/api/wallet-summary?wallet=0xbd94cade097e50ac&collection_id=95f28a17-224a-4025-96ad-adf8a4c63bfd`))
    const body = await res.json()
    expect(body.locked_fmv).toBe(12)
    expect(body.unlocked_count).toBe(4)
  })
})
