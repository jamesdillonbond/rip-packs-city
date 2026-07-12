// @vitest-environment jsdom
//
// lib/analytics/username-resolver.ts — the useResolveUsernames hook (fetch +
// React state) plus a smoke of the pure helpers. The hook normalizes/dedupes
// Flow addresses, batches them into /api/analytics/wallets/resolve-usernames,
// and returns a flat { addr → username } map. NOTE: the module holds a
// process-lifetime SESSION_CACHE + NEGATIVE_CACHE, so every test uses DISTINCT
// addresses to avoid cross-test cache bleed. (The pure truncateAddress/
// displayName exports are covered in depth by username-resolver.test.ts.)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import {
  useResolveUsernames,
  truncateAddress,
  displayName,
} from "@/lib/analytics/username-resolver"

let fetchMock: ReturnType<typeof vi.fn>

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("useResolveUsernames", () => {
  it("no-ops on an empty address list and never fetches", () => {
    const { result } = renderHook(() => useResolveUsernames([]))
    expect(result.current).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("ignores non-Flow-shaped addresses (no valid targets → no fetch)", () => {
    const { result } = renderHook(() => useResolveUsernames(["not-an-addr", "0x123"]))
    expect(result.current).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fetches the resolve endpoint and populates the name map on success", async () => {
    const addr = "0x00000000000000a1"
    fetchMock.mockReturnValue(okJson({ usernames: { [addr]: "alice" } }))

    const { result } = renderHook(() => useResolveUsernames([addr]))
    await waitFor(() => expect(result.current[addr]).toBe("alice"))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/analytics/wallets/resolve-usernames?addrs=${encodeURIComponent(addr)}`
    )
  })

  it("dedupes + lowercases mixed-case duplicate addresses into one target", async () => {
    const addr = "0x00000000000000b2"
    fetchMock.mockReturnValue(okJson({ usernames: { [addr]: "bob" } }))

    const { result } = renderHook(() =>
      useResolveUsernames(["0x00000000000000B2", addr, " 0x00000000000000b2 "])
    )
    await waitFor(() => expect(result.current[addr]).toBe("bob"))

    // One address after normalize → a single batched call.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/analytics/wallets/resolve-usernames?addrs=${encodeURIComponent(addr)}`
    )
  })

  it("swallows a rejected fetch and leaves the address unresolved (no throw)", async () => {
    const addr = "0x00000000000000c3"
    fetchMock.mockRejectedValue(new Error("network down"))

    const { result } = renderHook(() => useResolveUsernames([addr]))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    // Soft-fail: no entry for the address, map stays empty, nothing thrown.
    expect(result.current[addr]).toBeUndefined()
    expect(result.current).toEqual({})
  })

  it("treats a non-ok response as empty usernames (unresolved, no throw)", async () => {
    const addr = "0x00000000000000d4"
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) } as Response)

    const { result } = renderHook(() => useResolveUsernames([addr]))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(result.current[addr]).toBeUndefined()
  })
})

describe("pure helper smoke (covered fully in username-resolver.test.ts)", () => {
  it("truncateAddress head…tail lowercases", () => {
    expect(truncateAddress("0xBD94CADE097E50AC")).toBe("0xbd94…50ac")
  })
  it("displayName prefers a resolved name, else truncates", () => {
    const names = { "0xbd94cade097e50ac": "trevor" }
    expect(displayName("0xBD94CADE097E50AC", names)).toBe("trevor")
    expect(displayName("0x00000000000000e5", names)).toBe("0x0000…00e5")
  })
})
