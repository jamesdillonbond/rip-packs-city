import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/mcp/keys (GET + POST). User-cookie-auth via
// getCurrentUser; wallet ownership resolved through get_user_saved_wallets.
// FAIL-CLOSED AUTH is the priority. Mocks @/lib/supabase supabaseAdmin.rpc
// (dispatched by rpc name) and @/lib/auth/supabase-server.

const auth: { user: any } = { user: null }
// Keyed by rpc name so a single mock services get_user_saved_wallets / mcp_*.
const rpcState: Record<string, { data: any; error: any }> = {}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => rpcState[name] ?? { data: [], error: null },
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
  },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))

import { GET, POST } from "@/app/api/mcp/keys/route"

const req = (body: any = {}) => ({ json: async () => body }) as any

beforeEach(() => {
  auth.user = null
  for (const k of Object.keys(rpcState)) delete rpcState[k]
})

describe("GET /api/mcp/keys", () => {
  it("401s when unauthenticated", async () => {
    auth.user = null
    const res = await GET()
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("returns an empty key list when the user has no saved wallets", async () => {
    auth.user = { id: "u1" }
    rpcState["get_user_saved_wallets"] = { data: [], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.keys).toEqual([])
  })

  it("500s when the saved-wallet lookup errors", async () => {
    auth.user = { id: "u1" }
    rpcState["get_user_saved_wallets"] = { data: null, error: { message: "down" } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Saved-wallet lookup failed")
  })
})

describe("POST /api/mcp/keys", () => {
  it("401s when unauthenticated", async () => {
    auth.user = null
    const res = await POST(req({}))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("400s when the user has no saved wallets to attach a key to", async () => {
    auth.user = { id: "u1" }
    rpcState["get_user_saved_wallets"] = { data: [], error: null }
    const res = await POST(req({ label: "cli" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("no_saved_wallets")
  })

  it("403s when the requested wallet is not saved on the account", async () => {
    auth.user = { id: "u1" }
    rpcState["get_user_saved_wallets"] = { data: [{ wallet_addr: "0xaaa" }], error: null }
    const res = await POST(req({ wallet_address: "0xbbb" }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("Wallet not saved on this account")
  })
})
