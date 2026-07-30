import { describe, it, expect, vi, beforeEach } from "vitest"

// Pins lib/wallet-capability.ts — the Hybrid-Custody capability gate that decides
// whether a connected Flow wallet may TRANSACT (active HC parent => "advanced") or
// is read-only (Dapper-custodial child).
//
// THE FAILURE MODE THIS EXISTS TO CATCH: v_wallet_capability_tier is built from
// `linked_accounts`, so it only knows addresses the HC indexer has seen. Coalescing a
// MISSING row to "read_only" would silently downgrade every ordinary self-custody
// wallet on the platform. Absence must resolve to "unknown", with neither
// canTransact nor showLinkParentPrompt set.

const h = vi.hoisted(() => {
  const state: { data: any; error: any; calls: any[] } = { data: null, error: null, calls: [] }
  const builder: any = {
    select: (cols: string) => {
      state.calls.push(["select", cols])
      return builder
    },
    eq: (k: string, v: unknown) => {
      state.calls.push(["eq", k, v])
      return builder
    },
    maybeSingle: async () => ({ data: state.data, error: state.error }),
  }
  const from = vi.fn((table: string) => {
    state.calls.push(["from", table])
    return builder
  })
  return { state, from }
})

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: h.from } }))

const PARENT = "0xaaaaaaaaaaaaaaaa"
const CHILD = "0xbbbbbbbbbbbbbbbb"

beforeEach(() => {
  h.state.data = null
  h.state.error = null
  h.state.calls.length = 0
  h.from.mockClear()
})

async function subject() {
  return await import("@/lib/wallet-capability")
}

describe("getWalletCapability — absence is UNKNOWN, never read_only", () => {
  it("an address with no row resolves to unknown and is NOT downgraded to read_only", async () => {
    const { getWalletCapability } = await subject()
    h.state.data = null

    const cap = await getWalletCapability("0xcccccccccccccccc")

    expect(cap.tier).toBe("unknown")
    expect(cap.tier).not.toBe("read_only")
    expect(cap.role).toBe("unknown")
    expect(cap.known).toBe(false)
    // Neither grant capability nor claim the wallet is read-only.
    expect(cap.canTransact).toBe(false)
    expect(cap.showLinkParentPrompt).toBe(false)
  })

  it("a malformed address resolves to unknown without querying the view", async () => {
    const { getWalletCapability } = await subject()
    const cap = await getWalletCapability("not-an-address")
    expect(cap.tier).toBe("unknown")
    expect(cap.showLinkParentPrompt).toBe(false)
    expect(h.from).not.toHaveBeenCalled()
  })

  it.each([null, undefined, 42, {}, "0xABC"])(
    "non-address input %p resolves to unknown, not read_only",
    async (input) => {
      const { getWalletCapability } = await subject()
      const cap = await getWalletCapability(input as unknown)
      expect(cap.tier).toBe("unknown")
      expect(cap.canTransact).toBe(false)
      expect(cap.showLinkParentPrompt).toBe(false)
    },
  )

  it("a read failure THROWS rather than degrading to a tier", async () => {
    const { getWalletCapability } = await subject()
    h.state.error = { message: "boom" }
    await expect(getWalletCapability(PARENT)).rejects.toThrow(/v_wallet_capability_tier read failed/)
  })
})

describe("getWalletCapability — known wallets", () => {
  it("an active HC parent resolves advanced + canTransact", async () => {
    const { getWalletCapability } = await subject()
    h.state.data = {
      address: PARENT,
      role: "parent",
      capability_tier: "advanced",
      is_active_parent: true,
      is_active_child: false,
      active_children: 3,
      active_parent_addr: null,
      last_link_event_at: "2026-07-29T02:33:00Z",
    }

    const cap = await getWalletCapability(PARENT)

    expect(cap.tier).toBe("advanced")
    expect(cap.role).toBe("parent")
    expect(cap.known).toBe(true)
    expect(cap.canTransact).toBe(true)
    // An advanced wallet must never be prompted to link a parent.
    expect(cap.showLinkParentPrompt).toBe(false)
    expect(cap.activeChildren).toBe(3)
    expect(cap.lastLinkEventAt).toBe("2026-07-29T02:33:00Z")
  })

  it("an active child resolves read_only and gets the link-parent prompt", async () => {
    const { getWalletCapability } = await subject()
    h.state.data = {
      address: CHILD,
      role: "child",
      capability_tier: "read_only",
      is_active_parent: false,
      is_active_child: true,
      active_children: 0,
      active_parent_addr: PARENT,
      last_link_event_at: null,
    }

    const cap = await getWalletCapability(CHILD)

    expect(cap.tier).toBe("read_only")
    expect(cap.role).toBe("child")
    expect(cap.canTransact).toBe(false)
    expect(cap.showLinkParentPrompt).toBe(true)
    expect(cap.activeParentAddr).toBe(PARENT)
  })

  it("a standalone row (present but no ACTIVE link) is read_only, distinct from absent", async () => {
    const { getWalletCapability } = await subject()
    h.state.data = {
      address: CHILD,
      role: "standalone",
      capability_tier: "read_only",
      is_active_parent: false,
      is_active_child: false,
      active_children: 0,
      active_parent_addr: null,
      last_link_event_at: null,
    }

    const cap = await getWalletCapability(CHILD)
    expect(cap.role).toBe("standalone")
    expect(cap.tier).toBe("read_only")
    expect(cap.known).toBe(true)
  })

  it("any unrecognized capability_tier falls back to read_only, never advanced", async () => {
    const { getWalletCapability } = await subject()
    h.state.data = {
      address: CHILD,
      role: "weird",
      capability_tier: "something_new",
      is_active_parent: false,
      is_active_child: false,
      active_children: null,
      active_parent_addr: null,
      last_link_event_at: null,
    }

    const cap = await getWalletCapability(CHILD)
    expect(cap.tier).toBe("read_only")
    expect(cap.canTransact).toBe(false)
    expect(cap.role).toBe("unknown")
    expect(cap.activeChildren).toBe(0)
  })

  it("queries the capability view, matching on a lowercased address", async () => {
    const { getWalletCapability } = await subject()
    h.state.data = null
    await getWalletCapability("0xAAAAAAAAAAAAAAAA")

    expect(h.from).toHaveBeenCalledWith("v_wallet_capability_tier")
    expect(h.state.calls).toContainEqual(["eq", "address", PARENT])
  })
})

describe("normalizeFlowAddress", () => {
  it("lowercases a valid 0x+16 hex address", async () => {
    const { normalizeFlowAddress } = await subject()
    expect(normalizeFlowAddress("  0xAAAAAAAAAAAAAAAA  ")).toBe(PARENT)
  })

  it("rejects wrong-length, non-hex, and non-string input", async () => {
    const { normalizeFlowAddress } = await subject()
    expect(normalizeFlowAddress("0xaaa")).toBeNull()
    expect(normalizeFlowAddress("0xgggggggggggggggg")).toBeNull()
    expect(normalizeFlowAddress("aaaaaaaaaaaaaaaa")).toBeNull()
    expect(normalizeFlowAddress(null)).toBeNull()
  })
})
