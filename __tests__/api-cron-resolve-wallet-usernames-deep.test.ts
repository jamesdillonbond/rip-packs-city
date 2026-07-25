import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of /api/cron/resolve-wallet-usernames' DEFERRED after() body (the
// sibling only pins auth). Pulls unresolved wallets, resolves each via the TopShot
// getUserProfile GQL (through the proxy), and upserts hits / negative-caches misses.
// Legs pinned: auth, the unresolved-rpc error early-return, the hit (upsert
// topshot_gql) / miss (upsert gql_miss) / transient-error (no write) tri-state, and
// the pipeline_runs telemetry insert.

vi.hoisted(() => { process.env.INGEST_SECRET_TOKEN = "tok" }) // TOKEN is read at module load

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})
const st = vi.hoisted(() => ({
  unresolved: { data: [] as any[] | null, error: null as any },
  upsert: { error: null as any },
  upserts: [] as any[],
  pipelineRuns: [] as any[],
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => st.unresolved,
    from(table: string) {
      const b: any = {
        upsert: (row: any) => { st.upserts.push(row); return { then: (r: any) => r(st.upsert) } },
        insert: (row: any) => { st.pipelineRuns.push(row); return { then: (r: any) => r({ error: null }) } },
      }
      return b
    },
  },
}))

import { POST } from "@/app/api/cron/resolve-wallet-usernames/route"

const post = (auth = "Bearer tok") => ({ headers: new Headers(auth ? { authorization: auth } : {}), nextUrl: new URL("https://t/api/cron/resolve-wallet-usernames") }) as any

// Per-bare-address fetch fixture. "hit"→username, "miss"→no username, "err"→!ok.
const usernameByAddr: Record<string, string | "MISS" | "ERR"> = {}
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const addr = JSON.parse(init.body).variables.addr
    const v = usernameByAddr[addr]
    if (v === "ERR") return { ok: false, json: async () => ({}) }
    if (v === "MISS" || v === undefined) return { ok: true, json: async () => ({ data: { getUserProfile: { publicInfo: { username: null } } } }) }
    return { ok: true, json: async () => ({ data: { getUserProfile: { publicInfo: { username: v } } } }) }
  }))
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  capturedAfter = null
  st.unresolved = { data: [], error: null }
  st.upsert = { error: null }
  st.upserts = []
  st.pipelineRuns = []
  for (const k of Object.keys(usernameByAddr)) delete usernameByAddr[k]
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

async function drive() {
  const res = await POST(post())
  expect(res.status).toBe(200)
  expect(typeof capturedAfter).toBe("function")
  await capturedAfter!()
}
const runRow = () => st.pipelineRuns[0]

describe("/api/cron/resolve-wallet-usernames — deferred body", () => {
  it("401 without a token; after() not scheduled", async () => {
    const res = await POST(post("Bearer nope"))
    expect(res.status).toBe(401)
    expect(capturedAfter).toBeNull()
  })
  it("unresolved rpc error → logs ok:false and writes no username rows", async () => {
    st.unresolved = { data: null, error: { message: "rpc down" } }
    await drive()
    expect(runRow().ok).toBe(false)
    expect(runRow().error).toBe("rpc down")
    expect(st.upserts.length).toBe(0)
  })
  it("empty unresolved list → found 0, no upserts", async () => {
    await drive()
    expect(runRow().rows_found).toBe(0)
  })
  it("a hit upserts the username (source topshot_gql) and counts resolved", async () => {
    st.unresolved = { data: ["0xAAA"], error: null }
    usernameByAddr["aaa"] = "collector1"
    await drive()
    expect(st.upserts[0]).toMatchObject({ wallet_addr: "0xaaa", username: "collector1", source: "topshot_gql" })
    expect(runRow().rows_written).toBe(1)
    expect(runRow().extra.resolved).toBe(1)
  })
  it("a miss negative-caches (username null, source gql_miss)", async () => {
    st.unresolved = { data: ["0xBBB"], error: null }
    usernameByAddr["bbb"] = "MISS"
    await drive()
    expect(st.upserts[0]).toMatchObject({ wallet_addr: "0xbbb", username: null, source: "gql_miss" })
    expect(runRow().extra.missed).toBe(1)
  })
  it("a transient error writes nothing and counts errored", async () => {
    st.unresolved = { data: ["0xCCC"], error: null }
    usernameByAddr["ccc"] = "ERR"
    await drive()
    expect(st.upserts.length).toBe(0)
    expect(runRow().extra.errored).toBe(1)
  })
  it("processes a mixed batch (hit + miss)", async () => {
    st.unresolved = { data: ["0xAAA", "0xBBB"], error: null }
    usernameByAddr["aaa"] = "alice"; usernameByAddr["bbb"] = "MISS"
    await drive()
    expect(runRow().rows_found).toBe(2)
    expect(runRow().extra.resolved).toBe(1)
    expect(runRow().extra.missed).toBe(1)
  })
})
