import { describe, it, expect, vi, beforeEach } from "vitest"

// lib/chains/flow/topshot-username-resolve.ts — username → Flow wallet resolver.
// The live GraphQL layer (@/lib/topshot topshotGraphql) is mocked so no network
// fires. Pins: isWalletAddress regex, resolveTopShotUsername (@/whitespace
// stripping, first-try hit, 0x-prefix normalization, lowercased retry, null
// fallbacks) and resolveTopShotUsernameCacheAware (empty guard, RPC cache hit +
// 0x normalization, cache-miss → live → cache-writeback, GQL throw, not-found).

const topshotGraphql = vi.fn()
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: (...args: unknown[]) => topshotGraphql(...args),
}))

import {
  isWalletAddress,
  resolveTopShotUsername,
  resolveTopShotUsernameCacheAware,
} from "@/lib/chains/flow/topshot-username-resolve"

// Build a getUserProfileByUsername GraphQL response.
function profile(publicInfo: Record<string, unknown> | null) {
  return { getUserProfileByUsername: publicInfo ? { publicInfo } : null }
}

beforeEach(() => {
  topshotGraphql.mockReset()
})

describe("isWalletAddress", () => {
  it("accepts a 16-hex 0x address (trimmed)", () => {
    expect(isWalletAddress("0xbd94cade097e50ac")).toBe(true)
    expect(isWalletAddress("  0xBD94CADE097E50AC  ")).toBe(true)
  })
  it("rejects non-addresses", () => {
    expect(isWalletAddress("bd94cade097e50ac")).toBe(false) // no 0x
    expect(isWalletAddress("0x123")).toBe(false) // too short
    expect(isWalletAddress("jamesdillonbond")).toBe(false)
  })
})

describe("resolveTopShotUsername", () => {
  it("returns null for a blank / @-only username without hitting GraphQL", async () => {
    expect(await resolveTopShotUsername("   ")).toBeNull()
    expect(await resolveTopShotUsername("@@@")).toBeNull()
    expect(topshotGraphql).not.toHaveBeenCalled()
  })

  it("resolves on the first try, strips @, lowercases the flowAddress", async () => {
    topshotGraphql.mockResolvedValueOnce(
      profile({ flowAddress: "0xBD94CADE097E50AC", username: "jamesdillonbond", dapperID: "d-1" })
    )
    const out = await resolveTopShotUsername("@jamesdillonbond")
    expect(out).toEqual({
      walletAddress: "0xbd94cade097e50ac",
      username: "jamesdillonbond",
      dapperId: "d-1",
    })
    // the cleaned (already-lowercase) name doesn't trigger a second attempt
    expect(topshotGraphql).toHaveBeenCalledTimes(1)
    expect(topshotGraphql.mock.calls[0][1]).toEqual({ username: "jamesdillonbond" })
  })

  it("prepends 0x when the flowAddress lacks it, and falls back to cleaned username / null dapperId", async () => {
    topshotGraphql.mockResolvedValueOnce(
      profile({ flowAddress: "bd94cade097e50ac", username: null, dapperID: null })
    )
    const out = await resolveTopShotUsername("someUser")
    expect(out?.walletAddress).toBe("0xbd94cade097e50ac")
    // first try succeeds, so username falls back to the cleaned (original-case) input
    expect(out?.username).toBe("someUser")
    expect(out?.dapperId).toBeNull()
  })

  it("retries with a lowercased username when the first (mixed-case) try misses", async () => {
    topshotGraphql
      .mockResolvedValueOnce(profile({ flowAddress: null })) // MixedCase miss
      .mockResolvedValueOnce(profile({ flowAddress: "0xdeadbeefdeadbeef", username: "mixedcase", dapperID: null }))
    const out = await resolveTopShotUsername("MixedCase")
    expect(topshotGraphql).toHaveBeenCalledTimes(2)
    expect(topshotGraphql.mock.calls[0][1]).toEqual({ username: "MixedCase" })
    expect(topshotGraphql.mock.calls[1][1]).toEqual({ username: "mixedcase" })
    expect(out?.walletAddress).toBe("0xdeadbeefdeadbeef")
  })

  it("returns null when neither try yields a flowAddress", async () => {
    topshotGraphql
      .mockResolvedValueOnce(profile({ flowAddress: null }))
      .mockResolvedValueOnce(profile(null))
    expect(await resolveTopShotUsername("MixedCase")).toBeNull()
    expect(topshotGraphql).toHaveBeenCalledTimes(2)
  })

  it("returns null when publicInfo is absent (already-lowercase, single try)", async () => {
    topshotGraphql.mockResolvedValueOnce(profile(null))
    expect(await resolveTopShotUsername("ghost")).toBeNull()
    expect(topshotGraphql).toHaveBeenCalledTimes(1)
  })
})

describe("resolveTopShotUsernameCacheAware", () => {
  // Minimal supabase stub: routes .rpc(name, args) by name.
  function makeSupabase(handlers: Record<string, (args: unknown) => unknown>) {
    const rpc = vi.fn(async (name: string, args: unknown) => {
      const h = handlers[name]
      return h ? h(args) : { data: null, error: null }
    })
    return { client: { rpc } as never, rpc }
  }

  it("returns empty_username for a blank input without any RPC", async () => {
    const { client, rpc } = makeSupabase({})
    const out = await resolveTopShotUsernameCacheAware(client, "  @  ")
    expect(out).toEqual({ found: false, reason: "empty_username" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("short-circuits on a cache hit and does not call the live resolver", async () => {
    const { client } = makeSupabase({
      resolve_topshot_username: () => ({
        data: {
          found: true,
          wallet_address: "0xbd94cade097e50ac",
          username: "jamesdillonbond",
          source: "seeded_wallets",
          cache_layer: "seeded_wallets",
        },
        error: null,
      }),
    })
    const out = await resolveTopShotUsernameCacheAware(client, "jamesdillonbond")
    expect(out).toEqual({
      found: true,
      walletAddress: "0xbd94cade097e50ac",
      username: "jamesdillonbond",
      source: "seeded_wallets",
      cacheLayer: "seeded_wallets",
    })
    expect(topshotGraphql).not.toHaveBeenCalled()
  })

  it("prepends 0x to a cache-hit wallet_address that lacks it, defaulting source/layer", async () => {
    const { client } = makeSupabase({
      resolve_topshot_username: () => ({
        data: { found: true, wallet_address: "bd94cade097e50ac" },
        error: null,
      }),
    })
    const out = await resolveTopShotUsernameCacheAware(client, "user")
    expect(out).toMatchObject({
      found: true,
      walletAddress: "0xbd94cade097e50ac",
      username: "user",
      source: "wallet_usernames",
      cacheLayer: "wallet_usernames",
    })
  })

  it("on cache miss, resolves live then writes back via cache_topshot_username", async () => {
    const cacheWrite = vi.fn(() => ({ data: null, error: null }))
    const { client, rpc } = makeSupabase({
      resolve_topshot_username: () => ({ data: { found: false }, error: null }),
      cache_topshot_username: cacheWrite,
    })
    topshotGraphql.mockResolvedValueOnce(
      profile({ flowAddress: "0xdeadbeefdeadbeef", username: "liveuser", dapperID: "dap-9" })
    )
    const out = await resolveTopShotUsernameCacheAware(client, "liveuser")
    expect(out).toEqual({
      found: true,
      walletAddress: "0xdeadbeefdeadbeef",
      username: "liveuser",
      source: "topshot_gql",
      cacheLayer: "topshot_gql_live",
      dapperId: "dap-9",
    })
    // writeback fired with the resolved wallet + username
    expect(rpc).toHaveBeenCalledWith("cache_topshot_username", {
      p_username: "liveuser",
      p_wallet_address: "0xdeadbeefdeadbeef",
      p_source: "topshot_gql",
    })
  })

  it("treats a cache RPC error as a miss and still falls through to live", async () => {
    const { client } = makeSupabase({
      resolve_topshot_username: () => ({ data: null, error: { message: "boom" } }),
      cache_topshot_username: () => ({ data: null, error: null }),
    })
    topshotGraphql.mockResolvedValueOnce(
      profile({ flowAddress: "0xdeadbeefdeadbeef", username: "u", dapperID: null })
    )
    const out = await resolveTopShotUsernameCacheAware(client, "u")
    expect(out).toMatchObject({ found: true, cacheLayer: "topshot_gql_live" })
  })

  it("returns username_not_found_on_topshot when the live resolver yields null", async () => {
    const { client } = makeSupabase({
      resolve_topshot_username: () => ({ data: { found: false }, error: null }),
    })
    topshotGraphql.mockResolvedValueOnce(profile(null))
    const out = await resolveTopShotUsernameCacheAware(client, "ghost")
    expect(out).toEqual({ found: false, reason: "username_not_found_on_topshot" })
  })

  it("returns topshot_gql_error with detail when the live resolver throws", async () => {
    const { client } = makeSupabase({
      resolve_topshot_username: () => ({ data: { found: false }, error: null }),
    })
    topshotGraphql.mockRejectedValueOnce(new Error("proxy 503"))
    const out = await resolveTopShotUsernameCacheAware(client, "boomuser")
    expect(out).toEqual({
      found: false,
      reason: "topshot_gql_error",
      detail: "proxy 503",
    })
  })
})
