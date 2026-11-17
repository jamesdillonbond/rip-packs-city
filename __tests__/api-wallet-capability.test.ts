import { describe, it, expect, vi, beforeEach } from "vitest"

// Pins app/api/wallet/capability/route.ts — the read behind the Hybrid-Custody
// capability gate (advanced/transacting vs read-only). Asserts the auth guard, the
// invalid-JSON guard, the 502 on a view-read failure, and — the one that matters —
// that a wallet ABSENT from the index is reported as tier "unknown", never
// "read_only". Downgrading an unknown wallet would silently strip transacting
// affordances from every ordinary self-custody wallet on the platform.

const h = vi.hoisted(() => {
  const state: { user: any; capability: any; throws: any } = {
    user: { id: "u1" },
    capability: null,
    throws: null,
  }
  return { state }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!h.state.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 })
    }
    return h.state.user
  },
}))

vi.mock("@/lib/wallet-capability", () => ({
  getWalletCapability: async (addr: unknown) => {
    if (h.state.throws) throw new Error(h.state.throws)
    return h.state.capability ?? { address: addr, tier: "unknown", known: false }
  },
}))

function req(body: unknown, raw = false): any {
  return {
    json: async () => {
      if (raw) throw new Error("bad json")
      return body
    },
  }
}

beforeEach(() => {
  h.state.user = { id: "u1" }
  h.state.capability = null
  h.state.throws = null
})

async function POST(r: any) {
  const mod = await import("@/app/api/wallet/capability/route")
  return await mod.POST(r)
}

describe("POST /api/wallet/capability", () => {
  it("401s an anonymous caller", async () => {
    h.state.user = null
    const res: any = await POST(req({ address: "0xaaaaaaaaaaaaaaaa" }))
    expect(res.status).toBe(401)
  })

  it("400s on an unparseable body", async () => {
    const res: any = await POST(req(null, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_json")
  })

  it("returns the capability payload for a known advanced wallet", async () => {
    h.state.capability = {
      address: "0xaaaaaaaaaaaaaaaa",
      tier: "advanced",
      role: "parent",
      known: true,
      canTransact: true,
      showLinkParentPrompt: false,
    }
    const res: any = await POST(req({ address: "0xaaaaaaaaaaaaaaaa" }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.capability.tier).toBe("advanced")
    expect(j.capability.canTransact).toBe(true)
  })

  it('reports an unindexed wallet as "unknown", NOT "read_only"', async () => {
    h.state.capability = {
      address: "0xcccccccccccccccc",
      tier: "unknown",
      role: "unknown",
      known: false,
      canTransact: false,
      showLinkParentPrompt: false,
    }
    const res: any = await POST(req({ address: "0xcccccccccccccccc" }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.capability.tier).toBe("unknown")
    expect(j.capability.tier).not.toBe("read_only")
    // Neither affordance is asserted for an unknown wallet.
    expect(j.capability.canTransact).toBe(false)
    expect(j.capability.showLinkParentPrompt).toBe(false)
  })

  it("502s when the view read fails, rather than implying a read-only wallet", async () => {
    h.state.throws = "v_wallet_capability_tier read failed: boom"
    const res: any = await POST(req({ address: "0xaaaaaaaaaaaaaaaa" }))
    expect(res.status).toBe(502)
    const j = await res.json()
    expect(j.ok).toBe(false)
    expect(j.error).toBe("capability_read_failed")
    expect(j.capability).toBeUndefined()
  })

  it("passes a missing address through to the resolver (which yields unknown)", async () => {
    const res: any = await POST(req({}))
    expect(res.status).toBe(200)
    expect((await res.json()).capability.tier).toBe("unknown")
  })
})
