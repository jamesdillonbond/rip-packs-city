import { describe, it, expect, vi, beforeEach } from "vitest"

// lib/chains/flow/topshot-username-resolve.ts — username → Flow wallet resolver.
// Both live layers are mocked so no network fires: Atlas (the two-phase RPCs on
// the service-role client, 2026-09-06) and the legacy GraphQL fallback
// (@/lib/chains/flow/topshot topshotGraphql). Pins: isWalletAddress regex,
// resolveTopShotUsername (@/whitespace stripping, ATLAS FIRST — a clean Atlas
// "not found" is final and never falls through to GQL; an Atlas READ FAILURE
// does; 0x-prefix normalization; the GQL lowercased retry; the combined throw
// when both live layers fail) and resolveTopShotUsernameCacheAware (empty
// guard, RPC cache hit + 0x normalization, cache-miss → Atlas → writeback with
// source "atlas", cache-miss → Atlas failure → GQL → writeback "topshot_gql",
// not-found, both-failed error detail).

const topshotGraphql = vi.fn()
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: (...args: unknown[]) => topshotGraphql(...args),
}))

// The DEFAULT Atlas handle (used when no `atlas` option is passed) is the
// service-role client — stubbed here so resolveTopShotUsername() never reaches
// the real module.
const adminRpc = vi.fn()
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => adminRpc(...args) },
  supabase: { rpc: (...args: unknown[]) => adminRpc(...args) },
}))

// Atlas two-phase scripting: `begin` returns a request id, `collect` the envelope.
function atlasAnswers(rpc: ReturnType<typeof vi.fn>, collectEnvelope: unknown, beginId: number | { error: string } = 4242) {
  rpc.mockImplementation(async (name: string) => {
    if (name === "atlas_resolve_username_begin") {
      return typeof beginId === "number" ? { data: beginId, error: null } : { data: null, error: { message: beginId.error } }
    }
    if (name === "atlas_resolve_username_collect") return { data: collectEnvelope, error: null }
    return { data: null, error: null }
  })
}
const atlasFound = (flow = "0xBD94CADE097E50AC", username = "Jamesdillonbond") => ({ ok: true, found: true, flow_address: flow, username })
const atlasNotFound = { ok: true, found: false, flow_address: null, username: null }
const atlasFailed = { ok: false, error: "atlas_timeout", status: null }

import {
  isWalletAddress,
  lookupCachedTopShotUsername,
  resolveTopShotUsername,
  resolveTopShotUsernameCacheAware,
} from "@/lib/chains/flow/topshot-username-resolve"

// Build a getUserProfileByUsername GraphQL response.
function profile(publicInfo: Record<string, unknown> | null) {
  return { getUserProfileByUsername: publicInfo ? { publicInfo } : null }
}

beforeEach(() => {
  topshotGraphql.mockReset()
  adminRpc.mockReset()
  adminRpc.mockResolvedValue({ data: null, error: null })
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
  it("returns null for a blank / @-only username without hitting Atlas or GraphQL", async () => {
    expect(await resolveTopShotUsername("   ")).toBeNull()
    expect(await resolveTopShotUsername("@@@")).toBeNull()
    expect(adminRpc).not.toHaveBeenCalled()
    expect(topshotGraphql).not.toHaveBeenCalled()
  })

  it("resolves through Atlas first (two RPCs on the default service-role handle), strips @, lowercases the address, and never touches GraphQL", async () => {
    atlasAnswers(adminRpc, atlasFound())
    const out = await resolveTopShotUsername("@jamesdillonbond")
    expect(out).toEqual({
      walletAddress: "0xbd94cade097e50ac",
      username: "Jamesdillonbond",
      dapperId: null,
      source: "atlas",
    })
    expect(adminRpc.mock.calls.map((c) => c[0])).toEqual(["atlas_resolve_username_begin", "atlas_resolve_username_collect"])
    expect(adminRpc.mock.calls[0][1]).toEqual({ p_username: "jamesdillonbond" })
    expect(adminRpc.mock.calls[1][1]).toMatchObject({ p_request_id: 4242 })
    expect(topshotGraphql).not.toHaveBeenCalled()
  })

  it("a clean Atlas 'no such user' is FINAL — null, and the dead GraphQL host is not consulted", async () => {
    atlasAnswers(adminRpc, atlasNotFound)
    expect(await resolveTopShotUsername("ghost")).toBeNull()
    expect(topshotGraphql).not.toHaveBeenCalled()
  })

  it("an Atlas READ FAILURE falls through to the GraphQL ladder (cleaned, then lowercased)", async () => {
    atlasAnswers(adminRpc, atlasFailed)
    topshotGraphql
      .mockResolvedValueOnce(profile({ flowAddress: null })) // MixedCase miss
      .mockResolvedValueOnce(profile({ flowAddress: "0xdeadbeefdeadbeef", username: "mixedcase", dapperID: null }))
    const out = await resolveTopShotUsername("MixedCase")
    expect(topshotGraphql).toHaveBeenCalledTimes(2)
    expect(topshotGraphql.mock.calls[0][1]).toEqual({ username: "MixedCase" })
    expect(topshotGraphql.mock.calls[1][1]).toEqual({ username: "mixedcase" })
    expect(out).toMatchObject({ walletAddress: "0xdeadbeefdeadbeef", source: "topshot_gql" })
  })

  it("an Atlas begin() RPC error is a read failure too (GraphQL runs)", async () => {
    atlasAnswers(adminRpc, atlasFound(), { error: "permission denied for function" })
    topshotGraphql.mockResolvedValueOnce(profile({ flowAddress: "bd94cade097e50ac", username: null, dapperID: null }))
    const out = await resolveTopShotUsername("someUser")
    expect(out?.walletAddress).toBe("0xbd94cade097e50ac")
    expect(out?.username).toBe("someUser")
    expect(out?.dapperId).toBeNull()
  })

  it("throws with BOTH layers' errors when Atlas failed the read and GraphQL threw — never a silent null", async () => {
    atlasAnswers(adminRpc, atlasFailed)
    topshotGraphql.mockRejectedValueOnce(new Error("HTTP 530"))
    await expect(resolveTopShotUsername("anyone")).rejects.toThrow(/atlas: atlas_timeout; gql: HTTP 530/)
  })

  it("GraphQL-only ladder when the Atlas layer is explicitly disabled (atlas: null)", async () => {
    topshotGraphql
      .mockResolvedValueOnce(profile({ flowAddress: null }))
      .mockResolvedValueOnce(profile(null))
    expect(await resolveTopShotUsername("MixedCase", { atlas: null })).toBeNull()
    expect(topshotGraphql).toHaveBeenCalledTimes(2)
    expect(adminRpc).not.toHaveBeenCalled()
  })

  it("uses an injected Atlas handle instead of the default client", async () => {
    const own = vi.fn()
    atlasAnswers(own, atlasFound("0x0000000000000001", "someone"))
    const out = await resolveTopShotUsername("someone", { atlas: { rpc: own } })
    expect(out?.walletAddress).toBe("0x0000000000000001")
    expect(adminRpc).not.toHaveBeenCalled()
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

  it("on cache miss, resolves live through Atlas ON THE SAME CLIENT, then writes back with source 'atlas'", async () => {
    const cacheWrite = vi.fn(() => ({ data: null, error: null }))
    const { client, rpc } = makeSupabase({
      resolve_topshot_username: () => ({ data: { found: false }, error: null }),
      atlas_resolve_username_begin: () => ({ data: 77, error: null }),
      atlas_resolve_username_collect: () => ({ data: atlasFound("0xdeadbeefdeadbeef", "liveuser"), error: null }),
      cache_topshot_username: cacheWrite,
    })
    const out = await resolveTopShotUsernameCacheAware(client, "liveuser")
    expect(out).toEqual({
      found: true,
      walletAddress: "0xdeadbeefdeadbeef",
      username: "liveuser",
      source: "atlas",
      cacheLayer: "atlas_live",
      dapperId: null,
    })
    expect(rpc).toHaveBeenCalledWith("cache_topshot_username", {
      p_username: "liveuser",
      p_wallet_address: "0xdeadbeefdeadbeef",
      p_source: "atlas",
    })
    expect(topshotGraphql).not.toHaveBeenCalled()
    // the DEFAULT admin handle is NOT used — the caller's client is
    expect(adminRpc).not.toHaveBeenCalled()
  })

  it("on cache miss + Atlas read failure, resolves through GraphQL and writes back with source 'topshot_gql'", async () => {
    const cacheWrite = vi.fn(() => ({ data: null, error: null }))
    const { client, rpc } = makeSupabase({
      resolve_topshot_username: () => ({ data: { found: false }, error: null }),
      atlas_resolve_username_begin: () => ({ data: 78, error: null }),
      atlas_resolve_username_collect: () => ({ data: atlasFailed, error: null }),
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

  it("returns topshot_gql_error carrying BOTH layers' detail when every live layer failed to read", async () => {
    const { client } = makeSupabase({
      resolve_topshot_username: () => ({ data: { found: false }, error: null }),
      // no atlas_* handlers → begin() returns no request id → Atlas read failure
    })
    topshotGraphql.mockRejectedValueOnce(new Error("proxy 503"))
    const out = await resolveTopShotUsernameCacheAware(client, "boomuser")
    expect(out).toMatchObject({ found: false, reason: "topshot_gql_error" })
    expect((out as { detail?: string }).detail).toMatch(/atlas: .*; gql: proxy 503/)
  })
})

describe("lookupCachedTopShotUsername (the nine copy-holders' one-line ladder)", () => {
  function makeSupabase(handlers: Record<string, (args: unknown) => unknown>) {
    const rpc = vi.fn(async (name: string, args: unknown) => {
      const h = handlers[name]
      return h ? h(args) : { data: null, error: null }
    })
    return { client: { rpc } as never, rpc }
  }

  it("returns the cached wallet without asking Atlas", async () => {
    const { client, rpc } = makeSupabase({
      resolve_topshot_username: () => ({ data: { found: true, wallet_address: "bd94cade097e50ac" }, error: null }),
    })
    expect(await lookupCachedTopShotUsername(client, "@jamesdillonbond")).toBe("0xbd94cade097e50ac")
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["resolve_topshot_username"])
  })

  it("on a cache miss asks Atlas on the SAME client, writes the hit back with source 'atlas', and returns it", async () => {
    const { client, rpc } = makeSupabase({
      resolve_topshot_username: () => ({ data: { found: false }, error: null }),
      atlas_resolve_username_begin: () => ({ data: 12, error: null }),
      atlas_resolve_username_collect: () => ({ data: atlasFound("0xdeadbeefdeadbeef", "liveuser"), error: null }),
      cache_topshot_username: () => ({ data: null, error: null }),
    })
    expect(await lookupCachedTopShotUsername(client, "liveuser")).toBe("0xdeadbeefdeadbeef")
    expect(rpc.mock.calls.map((c) => c[0])).toEqual([
      "resolve_topshot_username",
      "atlas_resolve_username_begin",
      "atlas_resolve_username_collect",
      "cache_topshot_username",
    ])
    expect(rpc).toHaveBeenCalledWith("cache_topshot_username", { p_username: "liveuser", p_wallet_address: "0xdeadbeefdeadbeef", p_source: "atlas" })
    expect(adminRpc).not.toHaveBeenCalled()
  })

  it("a failed cache read is a miss, not a stop — Atlas still runs", async () => {
    const { client } = makeSupabase({
      resolve_topshot_username: () => ({ data: null, error: { message: "timeout" } }),
      atlas_resolve_username_begin: () => ({ data: 12, error: null }),
      atlas_resolve_username_collect: () => ({ data: atlasFound("0xdeadbeefdeadbeef", "u"), error: null }),
    })
    expect(await lookupCachedTopShotUsername(client, "u")).toBe("0xdeadbeefdeadbeef")
  })

  it("returns null on an Atlas read failure AND on a clean not-found (the caller's own live path decides the copy), never throws", async () => {
    const failed = makeSupabase({
      resolve_topshot_username: () => ({ data: { found: false }, error: null }),
      atlas_resolve_username_begin: () => ({ data: 12, error: null }),
      atlas_resolve_username_collect: () => ({ data: atlasFailed, error: null }),
    })
    expect(await lookupCachedTopShotUsername(failed.client, "u")).toBeNull()
    const ghost = makeSupabase({
      resolve_topshot_username: () => ({ data: { found: false }, error: null }),
      atlas_resolve_username_begin: () => ({ data: 12, error: null }),
      atlas_resolve_username_collect: () => ({ data: atlasNotFound, error: null }),
    })
    expect(await lookupCachedTopShotUsername(ghost.client, "ghost")).toBeNull()
    expect(ghost.rpc).not.toHaveBeenCalledWith("cache_topshot_username", expect.anything())
  })

  it("returns null for a blank username without any RPC", async () => {
    const { client, rpc } = makeSupabase({})
    expect(await lookupCachedTopShotUsername(client, " @ ")).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })
})
