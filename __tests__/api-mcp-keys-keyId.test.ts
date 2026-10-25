import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/mcp/keys/[keyId] (DELETE). User-cookie-auth
// via getCurrentUser; the handler takes a second arg { params: Promise<{keyId}> }.
// FAIL-CLOSED AUTH is the priority, then the UUID-format 400 guard and the
// key-not-found 404, PLUS the 2xx success path: when the key row belongs to one
// of the user's saved wallets, mcp_revoke_api_key runs and the route returns
// { ok:true, revoked:true }. Supabase is a stateful stub keyed by `state`.

const auth: { user: any } = { user: null }
const state: { keyRows: any[]; savedWallets: any[]; revoked: boolean } = {
  keyRows: [],
  savedWallets: [],
  revoked: false,
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) =>
      name === "get_user_saved_wallets"
        ? { data: state.savedWallets, error: null }
        : name === "mcp_revoke_api_key"
          ? { data: state.revoked, error: null }
          : { data: null, error: null },
    from: () => ({
      select: () => ({ eq: () => ({ limit: async () => ({ data: state.keyRows, error: null }) }) }),
    }),
  },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))
// Ownership (security audit 2026-10-25): wallets in `notOwned` are saved by this
// account but OWNED by another one.
const notOwned = new Set<string>()
vi.mock("@/lib/auth/owner-key-guard", () => ({
  requireOwnedKey: async (w: string) =>
    notOwned.has(w) ? new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) : { user: auth.user },
}))

import { DELETE } from "@/app/api/mcp/keys/[keyId]/route"

const req = () => ({}) as any
const ctx = (keyId: string) => ({ params: Promise.resolve({ keyId }) })

beforeEach(() => {
  auth.user = null
  notOwned.clear()
  state.keyRows = []
  state.savedWallets = []
  state.revoked = false
})

describe("DELETE /api/mcp/keys/[keyId]", () => {
  it("401s when unauthenticated (before touching params)", async () => {
    auth.user = null
    const res = await DELETE(req(), ctx("00000000-0000-0000-0000-000000000000"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("400s when keyId is not a UUID", async () => {
    auth.user = { id: "u1" }
    const res = await DELETE(req(), ctx("not-a-uuid"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("keyId must be a UUID")
  })

  it("404s when the key row does not exist", async () => {
    auth.user = { id: "u1" }
    const res = await DELETE(req(), ctx("11111111-1111-1111-1111-111111111111"))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("Key not found")
  })

  it("200s and revokes when the key belongs to a saved wallet", async () => {
    auth.user = { id: "u1" }
    state.keyRows = [{ wallet_address: "0xabcabcabcabcabcd", status: "active" }]
    state.savedWallets = [{ wallet_addr: "0xabcabcabcabcabcd" }]
    state.revoked = true
    const res = await DELETE(req(), ctx("11111111-1111-1111-1111-111111111111"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.revoked).toBe(true)
    expect(body.key_id).toBe("11111111-1111-1111-1111-111111111111")
  })
})

describe("DELETE /api/mcp/keys/[keyId] — SAVED is not OWNED (security audit 2026-10-25)", () => {
  it("403s, and never revokes, when the caller merely SAVED the key's wallet that another account owns", async () => {
    auth.user = { id: "u1" }
    state.keyRows = [{ wallet_address: "0x1234567890abcdef", status: "active" }]
    state.savedWallets = [{ wallet_addr: "0x1234567890abcdef" }]
    state.revoked = true
    notOwned.add("0x1234567890abcdef")
    const res = await DELETE(req(), ctx("00000000-0000-0000-0000-000000000000"))
    expect(res.status).toBe(403)
    expect((await res.json()).revoked).toBeUndefined()
  })
})
