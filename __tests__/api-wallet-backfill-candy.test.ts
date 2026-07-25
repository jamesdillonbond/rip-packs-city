import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/wallet-backfill-candy (Solana/Candy).
// Bearer INGEST_SECRET_TOKEN gated → fail-closed 401. Once authed the route
// validates a base58 wallet (400 otherwise), then either short-circuits to a
// discovery-pending 202 (INERT until CANDY_MLB_COLLECTION_ADDRESS is filled) or,
// when discovery is ready, returns the fire-and-forget accept 202 with the DAS
// walk deferred to after() (stubbed no-op). candyDiscoveryReady is mocked via a
// hoisted flag so both 202 shapes are covered. Mocks supabaseAdmin + the Solana
// DAS/normalize libs.

const COLL = "TODO_1_CANDY_CORE_COLLECTION_ADDRESS"
const state = vi.hoisted(() => ({
  ready: false,
  captured: null as null | (() => Promise<void>),
  pages: [] as any[][],
  paginateThrows: false,
  upsert: { data: [{ moment_id: "m1" }], error: null as any },
  runs: [] as any[],
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { state.captured = fn } }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_n: string, args: any) => { state.runs.push(args); return { data: null, error: null } },
    from: () => ({ upsert: () => ({ select: async () => state.upsert }) }),
  },
}))
vi.mock("@/lib/chains/solana/das", () => ({
  paginateOwner: async (_w: string, cb: (items: any[]) => Promise<void>) => {
    if (state.paginateThrows) throw new Error("DAS down")
    for (const page of state.pages) await cb(page)
  },
}))
vi.mock("@/lib/chains/solana/normalize", () => ({
  CANDY_MLB_COLLECTION_ADDRESS: "TODO_1_CANDY_CORE_COLLECTION_ADDRESS",
  CANDY_MLB_SLUG: "candy_mlb",
  candyDiscoveryReady: () => state.ready,
  isBurnt: (a: any) => a.kind === "burnt",
  isPack: (a: any) => a.kind === "pack",
  normalizeSerial: (a: any) => ({ moment_id: a.m ?? null, wallet_address: a.owner ?? null, collection_id: "c1" }),
}))

import { POST } from "@/app/api/wallet-backfill-candy/route"

const url = "https://t/api/wallet-backfill-candy"
const VALID_SOL = "So11111111111111111111111111111111111111112"
const req = (headers: Record<string, string> = {}, body: any = {}) =>
  ({ headers: new Headers(headers), json: async () => body }) as any

describe("POST /api/wallet-backfill-candy — fail-closed auth", () => {
  beforeEach(() => { delete process.env.INGEST_SECRET_TOKEN })
  it("401s without the bearer token", async () => {
    expect((await POST(req())).status).toBe(401)
  })
  it("401s with a bogus token", async () => {
    expect((await POST(req({ authorization: "Bearer x" }))).status).toBe(401)
  })
})

describe("POST /api/wallet-backfill-candy — secret configured (success + body guards)", () => {
  const TOKEN = "test-ingest-secret"
  beforeEach(() => { process.env.INGEST_SECRET_TOKEN = TOKEN; state.ready = false })
  afterEach(() => { delete process.env.INGEST_SECRET_TOKEN; state.ready = false })

  it("still 401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong", body: { wallet: VALID_SOL } }))).status).toBe(401)
  })

  it("400s on malformed JSON when authed", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s on a missing wallet field when authed", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: {} }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet field required")
  })

  it("400s on a non-base58 (Flow 0x) wallet when authed", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: { wallet: "0xbd94cade097e50ac" } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet is not a base58 Solana address")
  })

  it("202 discovery-pending short-circuit while discovery is not ready", async () => {
    state.ready = false
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: { wallet: VALID_SOL } }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(false)
    expect(body.skipped).toBe("discovery_pending")
    expect(body.collection).toBe("candy_mlb")
  })

  it("202-accepts once discovery is ready (DAS walk deferred to after())", async () => {
    state.ready = true
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}`, body: { wallet: VALID_SOL } }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.collection).toBe("candy_mlb")
    expect(body.wallet_address).toBe(VALID_SOL)
  })
})

// --- the deferred DAS walk: collection gate, burnt/pack skip, owner stamping ---

const asset = (over: any = {}) => ({
  kind: "icon", m: "m1", owner: "STALE_OWNER",
  grouping: [{ group_key: "collection", group_value: COLL }],
  ...over,
})

describe("POST /api/wallet-backfill-candy — deferred DAS walk", () => {
  beforeEach(() => {
    process.env.INGEST_SECRET_TOKEN = "tok"
    state.ready = true
    state.captured = null
    state.pages = []
    state.paginateThrows = false
    state.upsert = { data: [{ moment_id: "m1" }], error: null }
    state.runs = []
  })

  async function accept(body: any = { wallet: VALID_SOL }) {
    const res = await POST(makeReq({ url, auth: "Bearer tok", body }))
    return res
  }

  it("filters to the Candy collection and drops burnt + pack assets", async () => {
    state.pages = [[
      asset({ m: "m1" }),
      asset({ m: "m2", kind: "burnt" }),
      asset({ m: "m3", kind: "pack" }),
      asset({ m: "m4", grouping: [{ group_key: "collection", group_value: "SOME_OTHER" }] }),
      asset({ m: null }), // no moment_id -> dropped
    ]]
    await accept()
    await state.captured!()
    const run = state.runs.at(-1)
    expect(run.p_ok).toBe(true)
    expect(run.p_rows_found).toBe(1) // only the live in-collection asset with a moment id
    expect(run.p_extra.wallet).toBe(VALID_SOL)
  })

  it("stamps the QUERIED wallet so a stale DAS owner can't misattribute the row", async () => {
    let upserted: any[] = []
    state.pages = [[asset({ m: "m1", owner: "STALE_OWNER" })]]
    // capture what reached the upsert
    const { supabaseAdmin } = await import("@/lib/supabase")
    const orig = (supabaseAdmin as any).from
    ;(supabaseAdmin as any).from = () => ({
      upsert: (rows: any[]) => { upserted = rows; return { select: async () => state.upsert } },
    })
    try {
      await accept()
      await state.captured!()
    } finally {
      ;(supabaseAdmin as any).from = orig
    }
    expect(upserted).toHaveLength(1)
    expect(upserted[0].wallet_address).toBe(VALID_SOL) // not STALE_OWNER
  })

  it("tolerates a wmc upsert error (written stays 0, run still ok)", async () => {
    state.pages = [[asset()]]
    state.upsert = { data: null, error: { message: "wmc down" } }
    await accept()
    await state.captured!()
    const run = state.runs.at(-1)
    expect(run.p_ok).toBe(true)
    expect(run.p_rows_written).toBe(0)
  })

  it("logs ok:false when the DAS walk throws", async () => {
    state.paginateThrows = true
    await accept()
    await state.captured!()
    const run = state.runs.at(-1)
    expect(run.p_ok).toBe(false)
    expect(run.p_error).toContain("DAS down")
  })

  it("carries the force flag from the body and from ?force=true", async () => {
    state.pages = []
    const b = await (await accept({ wallet: VALID_SOL, force: true })).json()
    expect(b.force).toBe(true)
    const q = await (await POST(makeReq({ url: url + "?force=true", auth: "Bearer tok", body: { wallet: VALID_SOL } }))).json()
    expect(q.force).toBe(true)
  })

  it("does not schedule a walk when discovery is still pending", async () => {
    state.ready = false
    state.captured = null
    const res = await accept()
    expect((await res.json()).skipped).toBe("discovery_pending")
    expect(state.captured).toBeNull()
    expect(state.runs.at(-1).p_extra.skip_reason).toBe("discovery_pending")
  })
})
