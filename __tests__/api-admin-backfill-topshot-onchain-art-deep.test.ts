import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of /api/admin/backfill-topshot-onchain-art (the sibling only pins
// auth). Reads TopShotIPFSResolver.getCIDs per artless edition via Flow REST and
// fills HERO→thumbnail / VIDEO→video. Legs pinned: multi-secret auth, the select
// error → 500, the getCIDs decode (dict / nil-miss / transport-throw), the
// dead-media fill vs working-URL skip, the update error, and the pipeline_runs
// telemetry. Small batches keep the 100ms per-row sleep cheap.

const st = vi.hoisted(() => ({ rows: { data: [] as any[] | null, error: null as any }, updateRes: { error: null as any }, updates: [] as any[], pipelineRuns: [] as any[] }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminRequest: () => false, // force the INGEST/CRON secret path
  adminUnauthorizedResponse: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      let op: "select" | "update" = "select"
      const b: any = {
        select: () => b, update: (u: any) => { op = "update"; st.updates.push(u); return b },
        insert: (row: any) => { st.pipelineRuns.push(row); return { then: (r: any) => r({ error: null }) } },
        eq: () => b, or: () => b, not: () => b, order: () => b, limit: () => b,
        then: (resolve: any) => resolve(op === "update" ? st.updateRes : st.rows),
      }
      return b
    },
  },
}))

import { GET } from "@/app/api/admin/backfill-topshot-onchain-art/route"

const req = (auth = "Bearer ingest", qs = "") => ({ headers: new Headers(auth ? { authorization: auth } : {}), nextUrl: new URL(`https://t/api/admin/backfill-topshot-onchain-art${qs}`) }) as any
const row = (over: any = {}) => ({ id: "e1", external_id: "2:188", set_id_onchain: 2, play_id_onchain: 188, thumbnail_url: null, video_url: null, ...over })

let flowMode: "ok" | "nil" | "notok" = "ok"
let cidsMap: Record<string, string> = { HERO: "cidH", VIDEO: "cidV" }
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (flowMode === "notok") return { ok: false, status: 500, text: async () => "flow err" }
    const cdc = flowMode === "nil"
      ? { type: "Optional", value: null }
      : { type: "Optional", value: { type: "Dictionary", value: Object.entries(cidsMap).map(([k, v]) => ({ key: { value: k }, value: { value: v } })) } }
    return { ok: true, text: async () => `"${btoa(JSON.stringify(cdc))}"` }
  }))
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest"
  st.rows = { data: [row()], error: null }
  st.updateRes = { error: null }
  st.updates = []
  st.pipelineRuns = []
  flowMode = "ok"
  cidsMap = { HERO: "cidH", VIDEO: "cidV" }
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

describe("GET /api/admin/backfill-topshot-onchain-art", () => {
  it("401 without any accepted secret", async () => {
    expect((await GET(req("Bearer nope"))).status).toBe(401)
  })
  it("accepts the INGEST_SECRET_TOKEN bearer", async () => {
    st.rows = { data: [], error: null }
    expect((await GET(req())).status).toBe(200)
  })
  it("select error → 500", async () => {
    st.rows = { data: null, error: { message: "sel down" } }
    expect((await GET(req())).status).toBe(500)
  })
  it("fills HERO→thumbnail and VIDEO→video from the resolver CIDs", async () => {
    const body = await (await GET(req())).json()
    expect(body.thumbs_filled).toBe(1)
    expect(body.videos_filled).toBe(1)
    expect(st.updates[0].thumbnail_url).toContain("cidH")
    expect(st.updates[0].video_url).toContain("cidV")
  })
  it("counts a resolver nil result as a miss (no write)", async () => {
    flowMode = "nil"
    const body = await (await GET(req())).json()
    expect(body.resolver_misses).toBe(1)
    expect(st.updates.length).toBe(0)
  })
  it("a getCIDs transport error is recorded and marks the run not-ok", async () => {
    flowMode = "notok"
    const body = await (await GET(req())).json()
    expect(body.ok).toBe(false)
    expect(body.errors_count).toBe(1)
  })
  it("never overwrites a working (ipfs) media URL → treated as a miss", async () => {
    st.rows = { data: [row({ thumbnail_url: "https://ipfs.dapperlabs.com/ipfs/old", video_url: "https://ipfs.dapperlabs.com/ipfs/oldv" })], error: null }
    const body = await (await GET(req())).json()
    expect(st.updates.length).toBe(0) // both media already working
    expect(body.resolver_misses).toBe(1)
  })
  it("an editions update error is recorded", async () => {
    st.updateRes = { error: { message: "update failed" } }
    const body = await (await GET(req())).json()
    expect(body.errors_count).toBe(1)
    expect(body.thumbs_filled).toBe(0)
  })
  it("logs a pipeline_runs row with the scan tallies", async () => {
    await GET(req())
    expect(st.pipelineRuns[0].pipeline).toBe("topshot-onchain-art-backfill")
    expect(st.pipelineRuns[0].extra.scanned).toBe(1)
  })
})
