import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of POST /api/auth/fcl-verify (the sibling test only pins guards). It
// validates an FCL account proof, checks the nonce lifecycle, binds the proven
// address to body.addr, then either LINKS the wallet to the current session or
// MINTS a synthetic-email user + magic-link OTP. Legs pinned: body/addr/proof/
// nonce validation, the nonce error/unknown/consumed/expired 401s, the verify
// throw + invalid-proof 401s, the address-binding 401, the linked path, the minted
// path (+ generateLink error 500), and the referral credit.

const st = vi.hoisted(() => ({
  user: null as any,
  nonce: { data: null as any, error: null as any },
  refUser: { data: null as any },
  valid: true,
  verifyThrow: false,
  createUser: { error: null as any },
  link: { data: { properties: { hashed_token: "hash1" } } as any, error: null as any },
  listUsers: { data: { users: [{ id: "newuser" }] } as any },
  rpcCalls: [] as any[],
  awardCalls: [] as any[],
}))
vi.mock("@onflow/fcl", () => ({
  config: () => { const c: any = { put: () => c }; return c },
  AppUtils: { verifyAccountProof: async () => { if (st.verifyThrow) throw new Error("verify boom"); return st.valid } },
}))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => st.user }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async (...a: any[]) => { st.awardCalls.push(a) } }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: any = {
        select: () => b, update: () => b, eq: () => b,
        maybeSingle: async () => (table === "fcl_auth_nonces" ? st.nonce : st.refUser),
        then: (resolve: any) => resolve({ error: null }),
      }
      return b
    },
    rpc: async (name: string, params: any) => { st.rpcCalls.push({ name, params }); return { data: null, error: null } },
    auth: { admin: {
      createUser: async () => st.createUser,
      generateLink: async () => st.link,
      listUsers: async () => st.listUsers,
    } },
  },
}))

import { POST } from "@/app/api/auth/fcl-verify/route"

const post = (body: any, badJson = false) => ({ json: async () => { if (badJson) throw new Error("bad"); return body } }) as any
const ADDR = "0xabc0000000000001"
const goodBody = (over: any = {}) => ({ addr: ADDR, accountProof: { address: ADDR, nonce: "n1", signatures: [] }, ...over })
const validNonce = () => ({ data: { id: "non1", nonce: "n1", consumed_at: null, expires_at: new Date(Date.now() + 60000).toISOString() }, error: null })

beforeEach(() => {
  process.env.NEXT_PUBLIC_FCL_ACCESS_NODE = "http://flow"
  st.user = null
  st.nonce = validNonce()
  st.refUser = { data: null }
  st.valid = true
  st.verifyThrow = false
  st.createUser = { error: null }
  st.link = { data: { properties: { hashed_token: "hash1" } }, error: null }
  st.listUsers = { data: { users: [{ id: "newuser" }] } }
  st.rpcCalls = []
  st.awardCalls = []
})

describe("POST /api/auth/fcl-verify — validation", () => {
  it("400 invalid JSON", async () => { expect((await POST(post({}, true))).status).toBe(400) })
  it("400 when addr is missing / not 0x", async () => {
    expect((await POST(post(goodBody({ addr: undefined }))).then((r: any) => r.status))).toBe(400)
    expect((await POST(post(goodBody({ addr: "nope" })))).status).toBe(400)
  })
  it("400 when accountProof is not an object", async () => {
    expect((await POST(post(goodBody({ accountProof: "x" })))).status).toBe(400)
  })
  it("400 when the nonce is missing from the proof", async () => {
    expect((await POST(post(goodBody({ accountProof: { address: ADDR } })))).status).toBe(400)
  })
})

describe("POST /api/auth/fcl-verify — nonce + proof", () => {
  it("500 when the nonce lookup errors", async () => {
    st.nonce = { data: null, error: { message: "db down" } }
    expect((await POST(post(goodBody()))).status).toBe(500)
  })
  it("401 for an unknown nonce", async () => {
    st.nonce = { data: null, error: null }
    expect((await POST(post(goodBody()))).status).toBe(401)
  })
  it("401 for an already-consumed nonce", async () => {
    st.nonce = { data: { id: "n", nonce: "n1", consumed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() }, error: null }
    expect((await POST(post(goodBody()))).status).toBe(401)
  })
  it("401 for an expired nonce", async () => {
    st.nonce = { data: { id: "n", nonce: "n1", consumed_at: null, expires_at: new Date(Date.now() - 1000).toISOString() }, error: null }
    expect((await POST(post(goodBody()))).status).toBe(401)
  })
  it("401 when verifyAccountProof throws", async () => {
    st.verifyThrow = true
    expect((await POST(post(goodBody()))).status).toBe(401)
  })
  it("401 when the proof is invalid", async () => {
    st.valid = false
    expect((await POST(post(goodBody()))).status).toBe(401)
  })
  it("401 when the proven address does not match body.addr", async () => {
    const res = await POST(post(goodBody({ accountProof: { address: "0xdifferent00000001", nonce: "n1" } })))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toContain("does not match")
  })
})

describe("POST /api/auth/fcl-verify — link vs mint", () => {
  it("linked: an existing session verifies + awards, returns mode 'linked'", async () => {
    st.user = { id: "existing-user" }
    const body = await (await POST(post(goodBody()))).json()
    expect(body.ok).toBe(true)
    expect(body.mode).toBe("linked")
    expect(body.userId).toBe("existing-user")
    expect(st.rpcCalls.some((c) => c.name === "verify_wallet_via_fcl")).toBe(true)
    expect(st.awardCalls.some((a) => a[1] === "link_wallet")).toBe(true)
  })
  it("minted: no session → creates user, generates OTP, returns mode 'minted' + tokenHash", async () => {
    const res = await POST(post(goodBody()))
    const body = await res.json()
    expect(body.mode).toBe("minted")
    expect(body.tokenHash).toBe("hash1")
    expect(body.userId).toBe("newuser")
    expect(body.email).toContain("@flow.rip-packs-city.local")
  })
  it("minted: a generateLink error → 500", async () => {
    st.link = { data: null, error: { message: "otp mint failed" } }
    expect((await POST(post(goodBody()))).status).toBe(500)
  })
  it("minted: a valid referrer earns referral credit", async () => {
    st.refUser = { data: { id: "referrer-1" } }
    await POST(post(goodBody({ ref: "referrer-1" })))
    expect(st.awardCalls.some((a) => a[0] === "referrer-1" && a[1] === "referral_verified")).toBe(true)
  })
})
