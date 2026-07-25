import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of POST /api/profile/verify-link (the sibling only pins guards). Verifies
// a saved wallet W via an FCL account proof for a signed address A, when W==A or W
// is HybridCustody-linked to A. Legs pinned: requireUser rejection, the rate limit
// (429), body/wallet/proof/nonce validation, the nonce lifecycle 401s, the verify
// throw/invalid 401s, the self path, the linked path, the not-linked 403, the
// verify rpc error 500, and the not-saved 409.

let userCounter = 0
const st = vi.hoisted(() => ({
  user: { id: "u0" } as any,
  requireThrows: false,
  nonce: { data: null as any, error: null as any },
  valid: true,
  verifyThrow: false,
  linked: { data: [] as any[], error: null as any },
  verified: { data: [{ wallet: "w" }] as any, error: null as any },
}))
vi.mock("@onflow/fcl", () => ({
  config: () => { const c: any = { put: () => c }; return c },
  AppUtils: { verifyAccountProof: async () => { if (st.verifyThrow) throw new Error("verify boom"); return st.valid } },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => { if (st.requireThrows) throw new Response(JSON.stringify({ error: "unauth" }), { status: 401 }); return st.user },
}))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => {} }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from() {
      const b: any = { select: () => b, update: () => b, eq: () => b, maybeSingle: async () => st.nonce, then: (r: any) => r({ error: null }) }
      return b
    },
    rpc: async (name: string) => (name === "get_all_linked_addresses" ? st.linked : st.verified),
  },
}))

import { POST } from "@/app/api/profile/verify-link/route"

const A = "0xaaa0000000000001"
const post = (body: any, badJson = false) => ({ json: async () => { if (badJson) throw new Error("bad"); return body } }) as any
const goodBody = (over: any = {}) => ({ wallet_addr: A, accountProof: { address: A, nonce: "n1", signatures: [] }, ...over })
const validNonce = () => ({ data: { id: "non1", consumed_at: null, expires_at: new Date(Date.now() + 60000).toISOString() }, error: null })

beforeEach(() => {
  process.env.NEXT_PUBLIC_FCL_ACCESS_NODE = "http://flow"
  st.user = { id: `u${++userCounter}` }
  st.requireThrows = false
  st.nonce = validNonce()
  st.valid = true
  st.verifyThrow = false
  st.linked = { data: [], error: null }
  st.verified = { data: [{ wallet: "w" }], error: null }
})

describe("POST /api/profile/verify-link", () => {
  it("returns the requireUser rejection response", async () => {
    st.requireThrows = true
    expect((await POST(post(goodBody()))).status).toBe(401)
  })
  it("429 after exceeding the rate limit", async () => {
    let last: any
    for (let i = 0; i < 7; i++) last = await POST(post(goodBody()))
    expect(last.status).toBe(429)
  })
  it("400 invalid JSON / missing wallet / missing proof / missing nonce", async () => {
    expect((await POST(post({}, true))).status).toBe(400)
    expect((await POST(post(goodBody({ wallet_addr: "x" })))).status).toBe(400)
    expect((await POST(post(goodBody({ accountProof: "x" })))).status).toBe(400)
    expect((await POST(post(goodBody({ accountProof: { address: A } })))).status).toBe(400)
  })
  it("nonce lifecycle: 500 error / 401 unknown / 401 consumed / 401 expired", async () => {
    st.nonce = { data: null, error: { message: "db" } }
    expect((await POST(post(goodBody()))).status).toBe(500)
    st.nonce = { data: null, error: null }
    expect((await POST(post(goodBody()))).status).toBe(401)
    st.nonce = { data: { id: "n", consumed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() }, error: null }
    expect((await POST(post(goodBody()))).status).toBe(401)
    st.nonce = { data: { id: "n", consumed_at: null, expires_at: new Date(Date.now() - 1000).toISOString() }, error: null }
    expect((await POST(post(goodBody()))).status).toBe(401)
  })
  it("401 when verify throws or returns invalid", async () => {
    st.verifyThrow = true
    expect((await POST(post(goodBody()))).status).toBe(401)
    st.verifyThrow = false; st.valid = false
    expect((await POST(post(goodBody()))).status).toBe(401)
  })
  it("self path: W == A → verified via 'self'", async () => {
    const body = await (await POST(post(goodBody()))).json()
    expect(body.ok).toBe(true)
    expect(body.via).toBe("self")
  })
  it("linked path: W is HybridCustody-linked to A → verified via 'hybrid_custody_link'", async () => {
    const W = "0xbbb0000000000002"
    st.linked = { data: [W], error: null }
    const body = await (await POST(post(goodBody({ wallet_addr: W })))).json()
    expect(body.ok).toBe(true)
    expect(body.via).toBe("hybrid_custody_link")
  })
  it("403 when W is not linked to A", async () => {
    st.linked = { data: ["0xother00000000003"], error: null }
    const res = await POST(post(goodBody({ wallet_addr: "0xbbb0000000000002" })))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("not_linked")
  })
  it("500 when the linked-addresses rpc errors", async () => {
    st.linked = { data: null, error: { message: "link down" } }
    expect((await POST(post(goodBody({ wallet_addr: "0xbbb0000000000002" })))).status).toBe(500)
  })
  it("409 when the wallet is not saved (verify rpc empty)", async () => {
    st.verified = { data: [], error: null }
    const res = await POST(post(goodBody()))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("not_saved")
  })
  it("500 when the verify rpc errors", async () => {
    st.verified = { data: null, error: { message: "verify down" } }
    expect((await POST(post(goodBody()))).status).toBe(500)
  })
})
