import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of /api/trade-chain/propose (GET status + POST propose). Shelved
// behind RPC_TRADE_ESCROW_ADDRESS (503, POST only); GET is always reachable. Pins
// the POST propose pipeline: auth, body validation, the trade_matches lookup
// (404/500), the party check (403), the missing-offer-columns 409, the
// already-exists 409, the offers lookup (404), the unsupported-collection 400, the
// successful insert, and the insert-error 500 — plus GET's auth/param/lookup legs.

const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd" // topshot → valid slug

const st = vi.hoisted(() => ({
  user: { id: "u1" } as any,
  match: { data: null as any, error: null as any },
  existing: { data: null as any, error: null as any },
  offers: { data: [] as any[], error: null as any },
  inserted: { data: null as any, error: null as any },
}))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => st.user }))
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }))
vi.mock("@/lib/trade-escrow/fcl-submit", () => ({ submitProposeTrade: async () => ({ tx_id: "0xpropose" }) }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      let op: "select" | "insert" = "select"
      const result = () => {
        if (table === "trade_matches") return st.match
        if (table === "trade_chain_state") return op === "insert" ? st.inserted : st.existing
        if (table === "user_trade_offers") return st.offers
        return { data: null, error: null }
      }
      const b: any = {
        select: () => b, insert: () => { op = "insert"; return b }, eq: () => b, in: () => b,
        maybeSingle: async () => result(),
        then: (resolve: any) => resolve(result()),
      }
      return b
    },
  },
}))

import { POST, GET } from "@/app/api/trade-chain/propose/route"

const post = (body: any, badJson = false) => ({ json: async () => { if (badJson) throw new Error("bad"); return body } }) as any
const get = (qs = "?trade_match_id=tm1") => ({ nextUrl: new URL(`https://t/api/trade-chain/propose${qs}`) }) as any

const match = (over: any = {}) => ({ id: "tm1", buyer_user_id: "u1", seller_user_id: "u2", partya_offer_id: "oa", partyb_offer_id: "ob", ...over })
const offer = (id: string, over: any = {}) => ({ id, user_id: "u1", wallet_address: `0x${id}`, moment_id: "1", collection_id: TS_UUID, ...over })

beforeEach(() => {
  process.env.RPC_TRADE_ESCROW_ADDRESS = "0xescrow"
  st.user = { id: "u1" }
  st.match = { data: match(), error: null }
  st.existing = { data: null, error: null }
  st.offers = { data: [offer("oa"), offer("ob")], error: null }
  st.inserted = { data: { status: "proposed", trade_match_id: "tm1" }, error: null }
})

describe("POST /api/trade-chain/propose", () => {
  it("503 when the escrow contract is not configured", async () => {
    delete process.env.RPC_TRADE_ESCROW_ADDRESS
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(503)
  })
  it("401 unauthenticated", async () => {
    st.user = null
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(401)
  })
  it("400 invalid JSON / missing trade_match_id", async () => {
    expect((await POST(post({}, true))).status).toBe(400)
    expect((await POST(post({}))).status).toBe(400)
  })
  it("404 when the trade_match is missing", async () => {
    st.match = { data: null, error: null }
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(404)
  })
  it("500 when the trade_match lookup errors", async () => {
    st.match = { data: null, error: { message: "match down" } }
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(500)
  })
  it("403 when the user is not a party", async () => {
    st.match = { data: match({ buyer_user_id: "x", seller_user_id: "y" }), error: null }
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(403)
  })
  it("409 when the two-offer columns are missing", async () => {
    st.match = { data: match({ partya_offer_id: null }), error: null }
    const res = await POST(post({ trade_match_id: "tm1" }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("partya_offer_id")
  })
  it("409 when a trade_chain_state already exists", async () => {
    st.existing = { data: { id: "s1", status: "proposed" }, error: null }
    const res = await POST(post({ trade_match_id: "tm1" }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("already exists")
  })
  it("404 when one/both offers are not found", async () => {
    st.offers = { data: [offer("oa")], error: null } // ob missing
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(404)
  })
  it("400 when an offer references an unsupported collection UUID", async () => {
    st.offers = { data: [offer("oa"), offer("ob", { collection_id: "not-a-real-uuid" })], error: null }
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(400)
  })
  it("proposes: inserts a trade_chain_state row and returns it", async () => {
    const res = await POST(post({ trade_match_id: "tm1" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.state.status).toBe("proposed")
  })
  it("500 when the insert errors", async () => {
    st.inserted = { data: null, error: { message: "insert failed" } }
    expect((await POST(post({ trade_match_id: "tm1" }))).status).toBe(500)
  })
})

describe("GET /api/trade-chain/propose", () => {
  it("401 unauthenticated", async () => {
    st.user = null
    expect((await GET(get())).status).toBe(401)
  })
  it("400 without trade_match_id", async () => {
    expect((await GET(get("?"))).status).toBe(400)
  })
  it("404 when the match is missing", async () => {
    st.match = { data: null, error: null }
    expect((await GET(get())).status).toBe(404)
  })
  it("403 when not a party", async () => {
    st.match = { data: match({ buyer_user_id: "x", seller_user_id: "y" }), error: null }
    expect((await GET(get())).status).toBe(403)
  })
  it("returns the current chain state (or null) for a party", async () => {
    st.existing = { data: { status: "partial_a" }, error: null }
    const body = await (await GET(get())).json()
    expect(body.ok).toBe(true)
    expect(body.state.status).toBe("partial_a")
  })
})
