import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of POST /api/cost-basis-backfill (the sibling only pins auth). Fetches
// the wallet's owned Flow IDs via FCL, then chunk-calls backfill_cost_basis_from_ids
// to derive moment_acquisitions. Legs pinned: auth, the 16-hex wallet guard, the
// FCL failure → 500, the empty-ids short-circuit, the RPC result accumulation
// (string vs object data), and the per-chunk RPC-error collection.

vi.hoisted(() => { process.env.INGEST_SECRET_TOKEN = "tok" })
const q = vi.hoisted(() => ({ ids: [] as any, idsThrow: false }))
vi.mock("@/lib/chains/flow/flow", () => ({ default: { query: async () => { if (q.idsThrow) throw new Error("fcl down"); return q.ids } } }))
const st = vi.hoisted(() => ({ rpc: { data: null as any, error: null as any } }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: async () => st.rpc }) }))

import { POST } from "@/app/api/cost-basis-backfill/route"

const WALLET = "0x0000000000000001"
const post = (body: any, auth = "Bearer tok") => ({ headers: new Headers(auth ? { authorization: auth } : {}), json: async () => body }) as any

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  q.ids = []; q.idsThrow = false
  st.rpc = { data: { inserted: 0, skipped: 0, no_sale: 0 }, error: null }
})

describe("POST /api/cost-basis-backfill", () => {
  it("401 with a wrong token", async () => {
    expect((await POST(post({ wallet: WALLET }, "Bearer nope"))).status).toBe(401)
  })
  it("400 for a non-16-hex wallet", async () => {
    expect((await POST(post({ wallet: "0xshort" }))).status).toBe(400)
  })
  it("FCL failure → 500", async () => {
    q.idsThrow = true
    const res = await POST(post({ wallet: WALLET }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("Failed to fetch owned IDs")
  })
  it("no owned moments → the empty result shape", async () => {
    q.ids = []
    const body = await (await POST(post({ wallet: WALLET }))).json()
    expect(body.result.total_ids).toBe(0)
    expect(body.message).toContain("No owned moments")
  })
  it("accumulates RPC results across owned ids", async () => {
    q.ids = [1, 2, 3]
    st.rpc = { data: { inserted: 2, skipped: 1, no_sale: 0 }, error: null }
    const body = await (await POST(post({ wallet: WALLET }))).json()
    expect(body.wallet).toBe(WALLET)
    expect(body.result).toMatchObject({ inserted: 2, skipped: 1, no_sale: 0, total_ids: 3 })
  })
  it("parses string RPC data (JSON)", async () => {
    q.ids = [1]
    st.rpc = { data: JSON.stringify({ inserted: 5, skipped: 0, no_sale: 1 }), error: null }
    const body = await (await POST(post({ wallet: WALLET }))).json()
    expect(body.result.inserted).toBe(5)
    expect(body.result.no_sale).toBe(1)
  })
  it("collects a per-chunk RPC error into errors[]", async () => {
    q.ids = [1]
    st.rpc = { data: null, error: { message: "rpc failed" } }
    const body = await (await POST(post({ wallet: WALLET }))).json()
    expect(body.errors).toEqual(["rpc failed"])
    expect(body.result.inserted).toBe(0)
  })
})
