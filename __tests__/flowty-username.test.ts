import { describe, it, expect, beforeEach, vi } from "vitest"

// lib/flowty-username.ts — @handle resolution + address display formatting.
// truncateAddress/displayName are pure (buyer/seller labels on Top Sales, share
// cards, concierge). resolveUsernames layers the analytics_resolve_usernames RPC
// over a saved_wallets fallback; this file mocks the supabase seam to pin the
// dedup/lowercase input, the RPC-primary path, the RPC→saved_wallets fallback,
// and the double-failure → empty-map (truncation-only) branch.

const { state, rpcMock } = vi.hoisted(() => {
  const state: { rpc: any; rows: any } = {
    rpc: { data: null, error: null },
    rows: { data: null, error: null },
  }
  const rpcMock = vi.fn(async () => state.rpc)
  return { state, rpcMock }
})

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      in: () => b,
      then: (resolve: any) => resolve(state.rows),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: rpcMock }
  return { supabase: client, supabaseAdmin: client }
})

import { truncateAddress, displayName, resolveUsernames } from "@/lib/flowty-username"

beforeEach(() => {
  state.rpc = { data: null, error: null }
  state.rows = { data: null, error: null }
  rpcMock.mockClear()
})

describe("truncateAddress", () => {
  it("truncates a full Flow address to 0xABCD…WXYZ, lower-cased", () => {
    expect(truncateAddress("0xBD94CADE097E50AC")).toBe("0xbd94…50ac")
  })

  it("returns non-0x input unchanged (lower-cased)", () => {
    expect(truncateAddress("Trevor")).toBe("trevor")
  })

  it("leaves short 0x values untouched (<= 10 chars)", () => {
    expect(truncateAddress("0x1234")).toBe("0x1234")
    expect(truncateAddress("0x12345678")).toBe("0x12345678")
  })

  it("handles empty / falsy input", () => {
    expect(truncateAddress("")).toBe("")
    expect(truncateAddress(undefined as any)).toBe("")
  })
})

describe("displayName", () => {
  const names = new Map<string, string>([["0xbd94cade097e50ac", "jamesdillonbond"]])

  it("returns the resolved name (case-insensitive on the address key)", () => {
    expect(displayName("0xBD94CADE097E50AC", names)).toBe("jamesdillonbond")
  })

  it("falls back to a truncated address when no name is mapped", () => {
    expect(displayName("0xa3d67b29e104e701", names)).toBe("0xa3d6…e701")
  })
})

describe("resolveUsernames", () => {
  it("short-circuits to an empty map with no RPC call for empty input", async () => {
    const out = await resolveUsernames([])
    expect(out.size).toBe(0)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it("dedups + lowercases + drops falsy addresses before the RPC", async () => {
    state.rpc = { data: { "0xabc": "u1" }, error: null }
    await resolveUsernames(["0xABC", "0xabc", "", null as any])
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock.mock.calls[0][0]).toBe("analytics_resolve_usernames")
    expect(rpcMock.mock.calls[0][1]).toEqual({ p_addrs: ["0xabc"] })
  })

  it("resolves via analytics_resolve_usernames and never reads saved_wallets", async () => {
    state.rpc = { data: { "0xABC": "handleA", "0xdef": "handleB" }, error: null }
    // saved_wallets carries an error; if the fallback ran, out would still be
    // populated by the RPC — assert the RPC values win and size is exact.
    state.rows = { data: null, error: { message: "should not be read" } }
    const out = await resolveUsernames(["0xabc", "0xdef"])
    expect(out.get("0xabc")).toBe("handleA")
    expect(out.get("0xdef")).toBe("handleB")
    expect(out.size).toBe(2)
  })

  it("skips blank names in the RPC payload", async () => {
    state.rpc = { data: { "0xabc": "", "0xdef": "keep" }, error: null }
    const out = await resolveUsernames(["0xabc", "0xdef"])
    expect(out.has("0xabc")).toBe(false)
    expect(out.get("0xdef")).toBe("keep")
    expect(out.size).toBe(1)
  })

  it("falls back to saved_wallets when the RPC returns an empty object", async () => {
    state.rpc = { data: {}, error: null }
    state.rows = {
      data: [
        { wallet_addr: "0xABC", username: "saveduser", display_name: null },
        { wallet_addr: "0xdef", username: null, display_name: "DisplayOnly" },
      ],
      error: null,
    }
    const out = await resolveUsernames(["0xabc", "0xdef"])
    expect(out.get("0xabc")).toBe("saveduser")
    expect(out.get("0xdef")).toBe("DisplayOnly")
  })

  it("falls back to saved_wallets when the RPC errors", async () => {
    state.rpc = { data: null, error: { message: "rpc down" } }
    state.rows = {
      data: [{ wallet_addr: "0xabc", username: "fromfallback", display_name: null }],
      error: null,
    }
    const out = await resolveUsernames(["0xabc"])
    expect(out.get("0xabc")).toBe("fromfallback")
  })

  it("returns an empty map when both the RPC and saved_wallets yield nothing", async () => {
    state.rpc = { data: {}, error: null }
    state.rows = { data: null, error: { message: "no table" } }
    const out = await resolveUsernames(["0xabc"])
    expect(out.size).toBe(0)
  })

  it("skips saved_wallets rows with a blank address or no usable name", async () => {
    state.rpc = { data: {}, error: null }
    state.rows = {
      data: [
        { wallet_addr: "", username: "orphan", display_name: null },
        { wallet_addr: "0xabc", username: null, display_name: null },
      ],
      error: null,
    }
    const out = await resolveUsernames(["0xabc"])
    expect(out.size).toBe(0)
  })
})
