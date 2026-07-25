import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for GET /api/classify-unknowns. Two module-load-time
// facts drive the setup: (1) the module THROWS at import unless TS_PROXY_SECRET
// is set, and (2) auth uses a module-const INGEST_TOKEN captured at import — so
// both are set via vi.hoisted before the import runs. Auth accepts a Bearer
// header OR a ?token= query param.
//
// Beyond the guards, this drives the actual classification loop: Top Shot GQL
// lastPurchasePrice > 0 → marketplace, 0/null → pack_pull (inferred, since the
// batch is already checked_no_flowty), and every failure mode (non-ok HTTP,
// missing data node, thrown fetch, failed update) → unchanged. Also pins the
// acquired_date conditional, the wallet/limit params, and the remaining count.

const SECRET = vi.hoisted(() => {
  process.env.TS_PROXY_SECRET = "ts-proxy-secret"
  process.env.INGEST_SECRET_TOKEN = "unknowns-secret"
  return "unknowns-secret"
})

const state: {
  batch: any
  batchError: any
  updateErr: any
  remaining: any
  updates: any[]
  eqArgs: any[]
} = { batch: [], batchError: null, updateErr: null, remaining: 0, updates: [], eqArgs: [] }

vi.mock("@/lib/supabase", () => {
  const make = () => {
    let isUpdate = false
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { state.eqArgs.push([col, val]); return b },
      update: (u: any) => { isUpdate = true; state.updates.push(u); return b },
      limit: async () => ({ data: state.batch, error: state.batchError }),
      then: (resolve: any) =>
        resolve(isUpdate ? { error: state.updateErr } : { count: state.remaining, error: null }),
    }
    return b
  }
  return { supabaseAdmin: { from: () => make() } }
})

import { GET } from "@/app/api/classify-unknowns/route"
import { makeReq } from "./cron-req-helper"

const URL = "https://t/api/classify-unknowns"
const authed = (qs = "") => makeReq({ url: URL + qs, method: "GET", auth: `Bearer ${SECRET}` })

// Per-nft GQL fixture: number → lastPurchasePrice, "http" → non-ok, "nodata" →
// missing data node, "throw" → transport failure.
let gqlByNft: Record<string, number | null | "http" | "nodata" | "throw"> = {}
let createdAt: string | null = "2026-01-01T00:00:00Z"
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const id = JSON.parse(init.body).variables.momentId
    const v = gqlByNft[id]
    if (v === "throw") throw new Error("socket hang up")
    if (v === "http") return { ok: false, status: 502, json: async () => ({}) }
    if (v === "nodata") return { ok: true, json: async () => ({ data: { getMintedMoment: { data: null } } }) }
    return {
      ok: true,
      json: async () => ({ data: { getMintedMoment: { data: { flowId: id, lastPurchasePrice: v, createdAt } } } }),
    }
  }))
}

beforeEach(() => {
  state.batch = []
  state.batchError = null
  state.updateErr = null
  state.remaining = 0
  state.updates = []
  state.eqArgs = []
  gqlByNft = {}
  createdAt = "2026-01-01T00:00:00Z"
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

describe("GET /api/classify-unknowns — guards", () => {
  it("401s with no auth and no token", async () => {
    const res = await GET(makeReq({ url: URL, method: "GET" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })
  it("401s with a wrong bearer token", async () => {
    expect((await GET(makeReq({ url: URL, method: "GET", auth: "Bearer wrong" }))).status).toBe(401)
  })
  it("accepts the token via the ?token= query param", async () => {
    const res = await GET(makeReq({ url: URL, method: "GET", token: SECRET }))
    expect(res.status).toBe(200)
  })
  it("returns an empty-backlog summary when nothing is queued", async () => {
    const body = await (await GET(authed())).json()
    expect(body).toEqual({ processed: 0, marketplace: 0, pack_pull: 0, unchanged: 0, remaining: 0 })
  })
  it("500s when the batch query errors", async () => {
    state.batchError = { message: "db down" }
    const res = await GET(authed())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})

describe("GET /api/classify-unknowns — classification loop", () => {
  it("classifies a priced moment as a marketplace purchase", async () => {
    state.batch = [{ id: "r1", nft_id: "101" }]
    gqlByNft = { "101": 42.5 }
    state.remaining = 7
    const body = await (await GET(authed())).json()
    expect(body).toMatchObject({ processed: 1, marketplace: 1, pack_pull: 0, unchanged: 0, remaining: 7 })
    expect(state.updates[0]).toMatchObject({
      acquisition_method: "marketplace",
      acquisition_confidence: "flow_scan",
      buy_price: 42.5,
      source: "topshot",
      acquired_date: "2026-01-01T00:00:00Z",
    })
  })

  it("classifies a zero/null-price moment as an inferred pack pull", async () => {
    state.batch = [{ id: "r1", nft_id: "201" }, { id: "r2", nft_id: "202" }]
    gqlByNft = { "201": 0, "202": null }
    const body = await (await GET(authed())).json()
    expect(body).toMatchObject({ processed: 2, marketplace: 0, pack_pull: 2, unchanged: 0 })
    expect(state.updates[0]).toMatchObject({
      acquisition_method: "pack_pull",
      acquisition_confidence: "inferred_no_sale",
      buy_price: 0,
      source: "pack",
    })
  })

  it("omits acquired_date when the GQL has no createdAt", async () => {
    state.batch = [{ id: "r1", nft_id: "301" }]
    gqlByNft = { "301": 10 }
    createdAt = null
    await GET(authed())
    expect(state.updates[0]).not.toHaveProperty("acquired_date")
  })

  it("counts every GQL failure mode as unchanged (never misclassifies)", async () => {
    state.batch = [
      { id: "r1", nft_id: "401" }, // non-ok HTTP
      { id: "r2", nft_id: "402" }, // missing data node
      { id: "r3", nft_id: "403" }, // transport throw
    ]
    gqlByNft = { "401": "http", "402": "nodata", "403": "throw" }
    const body = await (await GET(authed())).json()
    expect(body).toMatchObject({ processed: 3, marketplace: 0, pack_pull: 0, unchanged: 3 })
    expect(state.updates).toHaveLength(0) // nothing written on a failed lookup
  })

  it("counts a failed update as unchanged rather than as a success", async () => {
    state.batch = [{ id: "r1", nft_id: "501" }]
    gqlByNft = { "501": 99 }
    state.updateErr = { message: "update down" }
    const body = await (await GET(authed())).json()
    expect(body).toMatchObject({ marketplace: 0, unchanged: 1 })
  })

  it("mixes outcomes across a batch", async () => {
    state.batch = [
      { id: "r1", nft_id: "601" },
      { id: "r2", nft_id: "602" },
      { id: "r3", nft_id: "603" },
    ]
    gqlByNft = { "601": 5, "602": 0, "603": "http" }
    const body = await (await GET(authed())).json()
    expect(body).toMatchObject({ processed: 3, marketplace: 1, pack_pull: 1, unchanged: 1 })
  })

  it("lower-cases the ?wallet= param and honours ?limit=", async () => {
    await GET(authed("?wallet=0xABCDEF0123456789&limit=5"))
    expect(state.eqArgs.some(([c, v]) => c === "wallet" && v === "0xabcdef0123456789")).toBe(true)
  })

  it("reports remaining: null when the count query yields no count", async () => {
    state.batch = [{ id: "r1", nft_id: "701" }]
    gqlByNft = { "701": 1 }
    state.remaining = null
    expect((await (await GET(authed())).json()).remaining).toBeNull()
  })
})
