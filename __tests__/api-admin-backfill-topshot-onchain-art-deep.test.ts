import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Deep drive of /api/admin/backfill-topshot-onchain-art (the sibling only pins
// auth). Reads TopShotIPFSResolver.getCIDs per artless edition via Flow REST and
// fills HERO→thumbnail / VIDEO→video. Legs pinned: multi-secret auth, the select
// error → 500, the getCIDs decode (dict / nil-miss / transport-throw), the
// dead-media fill vs working-URL skip, the update error, and the pipeline_runs
// telemetry. Small batches keep the 100ms per-row sleep cheap.

// Three reads, told apart by shape: the fresh leg (`.is(thumbnail_url, null)`),
// the legacy leg (`.or(...)`, served from st.rows) and the previous run's cursor
// (pipeline_runs select). Each legacy read's cursor filter and limit are recorded.
const st = vi.hoisted(() => ({
  rows: { data: [] as any[] | null, error: null as any },
  fresh: { data: [] as any[] | null, error: null as any },
  prev: { data: [] as any[] | null, error: null as any } as any,
  legacyReads: [] as Array<{ gt: string | null; limit: number | null; order: string | null }>,
  freshReads: 0,
  updateRes: { error: null as any }, updates: [] as any[], pipelineRuns: [] as any[],
}))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminRequest: () => false, // force the INGEST/CRON secret path
  adminUnauthorizedResponse: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      let op: "select" | "update" = "select"
      let leg: "fresh" | "legacy" | null = null
      const rec = { gt: null as string | null, limit: null as number | null, order: null as string | null }
      const b: any = {
        select: () => b, update: (u: any) => { op = "update"; st.updates.push(u); return b },
        insert: (row: any) => { st.pipelineRuns.push(row); return { then: (r: any) => r({ error: null }) } },
        eq: () => b, not: () => b,
        is: () => { leg = "fresh"; return b },
        or: () => { leg = "legacy"; return b },
        gt: (_c: string, v: string) => { rec.gt = v; return b },
        order: (c: string) => { rec.order = c; return b },
        limit: (n: number) => { rec.limit = n; return b },
        then: (resolve: any) => {
          if (op === "update") return resolve(st.updateRes)
          if (table === "pipeline_runs") return resolve(st.prev)
          if (leg === "fresh") { st.freshReads++; return resolve(st.fresh) }
          st.legacyReads.push(rec)
          return resolve(st.rows)
        },
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
  st.fresh = { data: [], error: null }
  st.prev = { data: [], error: null }
  st.legacyReads = []
  st.freshReads = 0
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

// The walk must PROGRESS (2026-10-14: one newest-first read re-scanned the same
// 300 resolver-nil editions every run, 0 written, while ~9,000 resolvable older
// ones were never reached).
describe("backfill-topshot-onchain-art — the legacy leg walks the whole population", () => {
  const rows = (n: number, from = 1) => Array.from({ length: n }, (_, i) => row({ id: `id-${String(from + i).padStart(3, "0")}`, thumbnail_url: "https://assets.nbatopshot.com/editions/x.jpg" }))

  it("resumes after the previous run's cursor and records where the next run starts", async () => {
    flowMode = "nil"
    st.prev = { data: [{ extra: { next_cursor: "id-002" } }], error: null }
    st.rows = { data: rows(2, 3), error: null } // full page of limit 2
    await GET(req("Bearer ingest", "?limit=2"))
    expect(st.legacyReads[0].gt).toBe("id-002")
    expect(st.legacyReads[0].order).toBe("id")
    expect(st.pipelineRuns[0].extra.next_cursor).toBe("id-004")
    expect(st.pipelineRuns[0].extra.terminated_reason).toBe("batch_full")
  })

  it("a run whose rows ALL miss still advances (the stuck-head defect)", async () => {
    flowMode = "nil"
    st.rows = { data: rows(2, 1), error: null }
    await GET(req("Bearer ingest", "?limit=2"))
    expect(st.pipelineRuns[0].rows_written).toBe(0)
    st.prev = { data: [{ extra: st.pipelineRuns[0].extra }], error: null }
    st.rows = { data: rows(2, 3), error: null }
    await GET(req("Bearer ingest", "?limit=2"))
    expect(st.legacyReads[1].gt).toBe("id-002") // not the same head again
  })

  it("a short page completes the lap: the next run starts from the beginning", async () => {
    flowMode = "nil"
    st.prev = { data: [{ extra: { next_cursor: "id-008" } }], error: null }
    st.rows = { data: rows(1, 9), error: null }
    const body = await (await GET(req("Bearer ingest", "?limit=5"))).json()
    expect(body.terminated_reason).toBe("lap_complete")
    expect(st.pipelineRuns[0].extra.next_cursor).toBeNull()
  })

  it("no previous run, or a failed cursor read, starts at the beginning (re-reading is safe, skipping is not)", async () => {
    await GET(req())
    expect(st.legacyReads[0].gt).toBeNull()
    st.prev = { data: null, error: { message: "runs down" } }
    await GET(req())
    expect(st.legacyReads[1].gt).toBeNull()
    expect(st.pipelineRuns[1].extra.cursor_read_error).toBe("runs down")
  })

  it("fresh drops (thumbnail NULL) are read newest-first in their own leg and share the batch", async () => {
    st.fresh = { data: [row({ id: "fresh-1" })], error: null }
    st.rows = { data: rows(1, 1), error: null }
    const body = await (await GET(req("Bearer ingest", "?limit=3"))).json()
    expect(st.freshReads).toBe(1)
    expect(st.legacyReads[0].limit).toBe(2) // batch 3 − 1 fresh
    expect(body.fresh_candidates).toBe(1)
    expect(body.scanned).toBe(2)
  })

  it("a row in both legs is scanned once", async () => {
    const both = row({ id: "id-001", thumbnail_url: null, video_url: "https://assets.nbatopshot.com/editions/v.mp4" })
    st.fresh = { data: [both], error: null }
    st.rows = { data: [both], error: null }
    const body = await (await GET(req("Bearer ingest", "?limit=3"))).json()
    expect(body.scanned).toBe(1)
  })

  it("a time-budget stop resumes after the last row SCANNED, never past unscanned rows", async () => {
    flowMode = "nil"
    st.rows = { data: rows(3, 1), error: null }
    let calls = 0
    // call 1 = startedAt, call 2 = first row's budget check; every later check is past the budget
    vi.spyOn(Date, "now").mockImplementation(() => (++calls <= 2 ? 1_000 : 10_000_000))
    const body = await (await GET(req("Bearer ingest", "?limit=3"))).json()
    vi.restoreAllMocks()
    expect(body.terminated_reason).toBe("time_budget_exceeded")
    expect(body.scanned).toBe(1)
    expect(st.pipelineRuns[0].extra.next_cursor).toBe("id-001")
  })

  it("a fresh-leg read error → 500, never a silent partial run", async () => {
    st.fresh = { data: null, error: { message: "fresh down" } }
    expect((await GET(req())).status).toBe(500)
  })
})
