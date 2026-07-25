import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/mcp/keys (GET + POST). User-cookie-auth via
// getCurrentUser; wallet ownership resolved through get_user_saved_wallets.
// FAIL-CLOSED AUTH is the priority. Mocks @/lib/supabase supabaseAdmin.rpc
// (dispatched by rpc name) and @/lib/auth/supabase-server.

const auth: { user: any } = { user: null }
// Keyed by rpc name so a single mock services get_user_saved_wallets / mcp_*.
const rpcState: Record<string, { data: any; error: any }> = {}
const rpcCalls: Array<{ name: string; args: any }> = []

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: any) => { rpcCalls.push({ name, args }); return rpcState[name] ?? { data: [], error: null } },
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
  rpcCalls.length = 0
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
    rpcState["get_user_saved_wallets"] = { data: [{ wallet_addr: "0xaaaa" }], error: null }
    const res = await POST(req({ wallet_address: "0xbbbb" }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("Wallet not saved on this account")
  })
})

// --- wallet resolution, key issuance, and the multi-wallet list merge ---

const SAVED = (...addrs: string[]) => ({
  data: addrs.map((a) => ({ wallet_addr: a, collection_id: "c", collection_slug: "s", nickname: null })),
  error: null,
})

describe("POST /api/mcp/keys — wallet resolution + issuance", () => {
  beforeEach(() => { auth.user = { id: "u1" } })

  it("500s when the saved-wallet lookup fails", async () => {
    rpcState.get_user_saved_wallets = { data: null, error: { message: "rpc down" } }
    const res = await POST(req({}))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Saved-wallet lookup failed")
  })

  it("400s with no_saved_wallets when the account has none", async () => {
    rpcState.get_user_saved_wallets = { data: [], error: null }
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("no_saved_wallets")
  })

  it("defaults to the first saved wallet and normalizes a bare-hex address", async () => {
    // no 0x prefix on the stored row -> loadUserWallets prepends it
    rpcState.get_user_saved_wallets = SAVED("BD94CADE097E50AC")
    rpcState.mcp_issue_api_key = { data: [{ key_id: "k1", raw_key: "rpc_live_x", key_prefix: "rpc_live" }], error: null }
    const body = await (await POST(req({}))).json()
    expect(body.ok).toBe(true)
    expect(body.wallet_address).toBe("0xbd94cade097e50ac")
    expect(body.raw_key).toBe("rpc_live_x")
  })

  it("403s when the requested wallet is not saved on the account", async () => {
    rpcState.get_user_saved_wallets = SAVED("0xaaaaaaaaaaaaaaaa")
    const res = await POST(req({ wallet_address: "0xbbbbbbbbbbbbbbbb" }))
    expect(res.status).toBe(403)
  })

  it("honours a requested wallet that IS saved (case-insensitively)", async () => {
    rpcState.get_user_saved_wallets = SAVED("0xaaaaaaaaaaaaaaaa")
    rpcState.mcp_issue_api_key = { data: [{ key_id: "k1", raw_key: "r", key_prefix: "p" }], error: null }
    const body = await (await POST(req({ wallet_address: "0xAAAAAAAAAAAAAAAA" }))).json()
    expect(body.wallet_address).toBe("0xaaaaaaaaaaaaaaaa")
  })

  it("ignores a malformed wallet_address and falls back to the default", async () => {
    rpcState.get_user_saved_wallets = SAVED("0xaaaaaaaaaaaaaaaa")
    rpcState.mcp_issue_api_key = { data: [{ key_id: "k1", raw_key: "r", key_prefix: "p" }], error: null }
    const body = await (await POST(req({ wallet_address: "nope" }))).json()
    expect(body.wallet_address).toBe("0xaaaaaaaaaaaaaaaa")
  })

  it("trims and 80-char-truncates the label, and requests read scope only", async () => {
    rpcState.get_user_saved_wallets = SAVED("0xaaaaaaaaaaaaaaaa")
    rpcState.mcp_issue_api_key = { data: [{ key_id: "k1", raw_key: "r", key_prefix: "p" }], error: null }
    await POST(req({ label: "  " + "x".repeat(120) + "  " }))
    const issue = rpcCalls.find((c) => c.name === "mcp_issue_api_key")!
    expect(issue.args.p_label).toHaveLength(80)
    expect(issue.args.p_scopes).toEqual(["read"])
  })

  it("nulls a whitespace-only label rather than storing blanks", async () => {
    rpcState.get_user_saved_wallets = SAVED("0xaaaaaaaaaaaaaaaa")
    rpcState.mcp_issue_api_key = { data: [{ key_id: "k1", raw_key: "r", key_prefix: "p" }], error: null }
    await POST(req({ label: "   " }))
    expect(rpcCalls.find((c) => c.name === "mcp_issue_api_key")!.args.p_label).toBeNull()
  })

  it("500s when issuance errors, and when it returns no raw_key", async () => {
    rpcState.get_user_saved_wallets = SAVED("0xaaaaaaaaaaaaaaaa")
    rpcState.mcp_issue_api_key = { data: null, error: { message: "issue down" } }
    expect((await POST(req({}))).status).toBe(500)

    rpcState.mcp_issue_api_key = { data: [{ key_id: "k1", key_prefix: "p" }], error: null } // no raw_key
    const res = await POST(req({}))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Issue returned no key")
  })
})

describe("GET /api/mcp/keys — multi-wallet merge", () => {
  beforeEach(() => { auth.user = { id: "u1" } })

  it("500s when the saved-wallet lookup fails", async () => {
    rpcState.get_user_saved_wallets = { data: null, error: { message: "down" } }
    expect((await GET()).status).toBe(500)
  })

  it("returns an empty key list when the user has no saved wallets", async () => {
    rpcState.get_user_saved_wallets = { data: [], error: null }
    expect(await (await GET()).json()).toEqual({ ok: true, keys: [] })
  })

  it("merges keys across wallets, tags each with its wallet, and sorts newest-first", async () => {
    rpcState.get_user_saved_wallets = SAVED("0xaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbb")
    rpcState.mcp_list_keys = {
      data: [
        { key_id: "old", key_prefix: "p", label: null, plan: "free", status: "active", scopes: ["read"], created_at: "2026-01-01T00:00:00Z", last_used_at: null, expires_at: null },
        { key_id: "new", key_prefix: "p", label: null, plan: "free", status: "active", scopes: ["read"], created_at: "2026-07-01T00:00:00Z", last_used_at: null, expires_at: null },
      ],
      error: null,
    }
    const body = await (await GET()).json()
    // 2 wallets x 2 keys, newest first
    expect(body.keys).toHaveLength(4)
    expect(body.keys[0].key_id).toBe("new")
    expect(new Set(body.keys.map((k: any) => k.wallet_address))).toEqual(
      new Set(["0xaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbb"]),
    )
  })

  it("skips a wallet whose key listing errors instead of failing the whole request", async () => {
    rpcState.get_user_saved_wallets = SAVED("0xaaaaaaaaaaaaaaaa")
    rpcState.mcp_list_keys = { data: null, error: { message: "list down" } }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).keys).toEqual([])
  })

  it("dedups a wallet saved under multiple collections", async () => {
    rpcState.get_user_saved_wallets = SAVED("0xaaaaaaaaaaaaaaaa", "0xaaaaaaaaaaaaaaaa")
    rpcState.mcp_list_keys = { data: [], error: null }
    await GET()
    expect(rpcCalls.filter((c) => c.name === "mcp_list_keys")).toHaveLength(1)
  })
})
