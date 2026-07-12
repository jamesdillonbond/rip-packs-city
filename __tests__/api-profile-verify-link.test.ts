import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/verify-link (POST only). FCL
// account-proof + HybridCustody link verification — requireUser-gated (after
// a non-throwing ensureFcl() config call). The happy path requires a valid
// on-chain account proof (not a simple mockable seam), so this pins the
// fail-closed 401 and the body guards that return before verification:
// invalid-JSON 400, wallet_addr 400, accountProof 400, nonce-missing 400.

const state: { user: any } = { user: null }

vi.mock("@onflow/fcl", () => {
  const cfg: any = { put: () => cfg }
  return { config: () => cfg, AppUtils: { verifyAccountProof: async () => false } }
})

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, update: () => b, eq: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: any) => resolve({ data: null, error: null }),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => ({ data: [], error: null }) }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

vi.mock("@/lib/rewards", () => ({ awardPoints: async () => undefined }))

import { POST } from "@/app/api/profile/verify-link/route"

const req = (body?: any, throws = false) =>
  ({
    json: async () => {
      if (throws) throw new Error("bad json")
      return body
    },
  }) as any

beforeEach(() => {
  state.user = null
})

describe("POST /api/profile/verify-link", () => {
  it("401s when unauthenticated (fail-closed)", async () => {
    const res = await POST(req({ wallet_addr: "0xabc", accountProof: {} }))
    expect(res.status).toBe(401)
  })

  it("400s on invalid JSON body", async () => {
    state.user = { id: "u1" }
    const res = await POST(req(undefined, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s without a 0x wallet_addr", async () => {
    state.user = { id: "u1" }
    const res = await POST(req({ wallet_addr: "not-hex", accountProof: {} }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet_addr (0x...) required")
  })

  it("400s without an accountProof object", async () => {
    state.user = { id: "u1" }
    const res = await POST(req({ wallet_addr: "0xabc" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("accountProof object required")
  })

  it("400s when accountProof.nonce is missing", async () => {
    state.user = { id: "u1" }
    const res = await POST(req({ wallet_addr: "0xabc", accountProof: { address: "0xabc" } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("accountProof.nonce missing")
  })
})
