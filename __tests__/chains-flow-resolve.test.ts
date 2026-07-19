import { describe, it, expect, vi } from "vitest"

// Pins lib/chains/flow/flow-resolve.ts — resolveToFlowAddress, the concierge/
// wallet-paste helper that turns a raw 0x address OR a TopShot username into a
// canonical 0x-prefixed Flow address. Previously 0% coverage. The only network
// seam is topshotGraphql (@/lib/topshot), mocked here; we cover every branch:
// already-an-address short-circuit, username lookup, the lowercase-retry leg,
// the in-memory TTL cache hit, the 0x-prefix normalization of a bare address,
// and the "could not resolve" throw (incl. the swallowed-error miss).
//
// NOTE: the mock is reset at the TOP of each test body rather than in a
// beforeEach — a vitest quirk turns a beforeEach-reset mock's synchronous throw
// into a floating rejected promise, which the module's try/catch handles but the
// runner still flags as unhandled. Resetting in-body preserves the sync throw.

const gql = vi.fn()
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: (...a: any[]) => gql(...a) }))

import { resolveToFlowAddress } from "@/lib/chains/flow/flow-resolve"

describe("resolveToFlowAddress — address short-circuit", () => {
  it("returns a valid 0x-prefixed 16-hex address unchanged without any network call", async () => {
    gql.mockReset()
    const addr = "0xbd94cade097e50ac"
    const r = await resolveToFlowAddress(addr)
    expect(r).toBe(addr)
    expect(gql).not.toHaveBeenCalled()
  })

  it("trims surrounding whitespace on a raw address", async () => {
    gql.mockReset()
    const r = await resolveToFlowAddress("  0xbd94cade097e50ac  ")
    expect(r).toBe("0xbd94cade097e50ac")
    expect(gql).not.toHaveBeenCalled()
  })
})

describe("resolveToFlowAddress — username resolution", () => {
  it("resolves a username via GraphQL, stripping a leading @ and 0x-prefixing a bare flowAddress", async () => {
    gql.mockReset()
    // publicInfo.flowAddress arrives WITHOUT the 0x prefix → ensureFlowPrefix adds it.
    gql.mockResolvedValueOnce({
      getUserProfileByUsername: { publicInfo: { flowAddress: "b5053ef95e702657", username: "u1" } },
    })
    const r = await resolveToFlowAddress("@u1_unique")
    expect(r).toBe("0xb5053ef95e702657")
    // Username passed to the query has the @ stripped.
    expect(gql.mock.calls[0][1]).toEqual({ username: "u1_unique" })
  })

  it("keeps an already-0x-prefixed flowAddress from the profile", async () => {
    gql.mockReset()
    gql.mockResolvedValueOnce({
      getUserProfileByUsername: { publicInfo: { flowAddress: "0xa3d67b29e104e701" } },
    })
    const r = await resolveToFlowAddress("prefixed_user")
    expect(r).toBe("0xa3d67b29e104e701")
  })

  it("caches a resolved username so a second lookup skips the network", async () => {
    gql.mockReset()
    gql.mockResolvedValueOnce({
      getUserProfileByUsername: { publicInfo: { flowAddress: "0x1111111111111111" } },
    })
    const first = await resolveToFlowAddress("cachedUser")
    const second = await resolveToFlowAddress("cachedUser")
    expect(first).toBe("0x1111111111111111")
    expect(second).toBe("0x1111111111111111")
    expect(gql).toHaveBeenCalledTimes(1) // second served from cache
  })

  it("retries with a lowercased username when the mixed-case lookup misses", async () => {
    gql.mockReset()
    gql
      .mockResolvedValueOnce({ getUserProfileByUsername: { publicInfo: { flowAddress: null } } })
      .mockResolvedValueOnce({ getUserProfileByUsername: { publicInfo: { flowAddress: "0x2222222222222222" } } })
    const r = await resolveToFlowAddress("MixedCase")
    expect(r).toBe("0x2222222222222222")
    expect(gql).toHaveBeenCalledTimes(2)
    expect(gql.mock.calls[0][1]).toEqual({ username: "MixedCase" })
    expect(gql.mock.calls[1][1]).toEqual({ username: "mixedcase" })
  })

  it("swallows a GraphQL error (treated as a miss) and then throws could-not-resolve", async () => {
    gql.mockReset()
    // Synchronous throw so tryResolve's try/catch handles it cleanly.
    gql.mockImplementation(() => { throw new Error("network") })
    let err: any
    try {
      await resolveToFlowAddress("boom_user")
    } catch (e) {
      err = e
    }
    expect(String(err?.message)).toMatch(/Could not resolve/)
  })

  it("throws could-not-resolve when the profile has no flowAddress and no case retry applies", async () => {
    gql.mockReset()
    gql.mockImplementation(() => ({ getUserProfileByUsername: { publicInfo: { flowAddress: null } } }))
    await expect(resolveToFlowAddress("lower_only")).rejects.toThrow(/lower_only/)
    // all-lowercase input → no second retry attempt
    expect(gql).toHaveBeenCalledTimes(1)
  })
})
