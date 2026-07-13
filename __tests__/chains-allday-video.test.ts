import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Unit tests for lib/chains/flow/allday-video.ts — backfillAllDayEditionVideos,
// the freshness-tail cron helper that fills editions.video_url from the AllDay
// consumer GraphQL (via the topshot-proxy worker). Previously 0% coverage. Two
// seams: supabaseAdmin (mocked, thenable query builder driven by a hoisted
// result holder) and global fetch (stubbed to return the worker's text body).
// We cover the config guard, the select-error/empty branches, the happy write
// path (found/written/noVideo accounting + NULL-only update), the id filter,
// and fetchChunk's CF-challenge / bad-JSON / network retries and GQL-error throw.

const h = vi.hoisted(() => ({
  selectResult: { data: [] as any[], error: null as any },
  updateResult: { error: null as any },
}))

vi.mock("@/lib/supabase", () => {
  const sb: any = {}
  const chain = ["from", "select", "eq", "in", "order", "gte", "lte", "lt", "gt", "is", "not", "or", "range", "match", "insert", "upsert", "delete", "returns"]
  let mode: "select" | "update" = "select"
  for (const m of chain) sb[m] = () => sb
  sb.from = () => { mode = "select"; return sb }
  sb.select = () => { mode = "select"; return sb }
  sb.update = () => { mode = "update"; return sb }
  sb.limit = () => sb
  sb.then = (resolve: any, reject: any) => {
    const r = mode === "update" ? h.updateResult : h.selectResult
    return Promise.resolve(r).then(resolve, reject)
  }
  sb.rpc = async () => ({ data: null, error: null })
  return { supabaseAdmin: sb, supabase: sb }
})

import { backfillAllDayEditionVideos } from "@/lib/chains/flow/allday-video"

const savedUrl = process.env.TS_PROXY_URL
const savedSecret = process.env.TS_PROXY_SECRET

beforeEach(() => {
  process.env.TS_PROXY_URL = "https://proxy.example.workers.dev"
  process.env.TS_PROXY_SECRET = "s3cr3t"
  h.selectResult = { data: [], error: null }
  h.updateResult = { error: null }
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (savedUrl === undefined) delete process.env.TS_PROXY_URL
  else process.env.TS_PROXY_URL = savedUrl
  if (savedSecret === undefined) delete process.env.TS_PROXY_SECRET
  else process.env.TS_PROXY_SECRET = savedSecret
})

// Build a worker text body with the given flowID→videoUrl edges.
function edgesBody(pairs: Array<[number | null, any]>): string {
  return JSON.stringify({
    data: {
      searchEditions: {
        edges: pairs.map(([flowID, videoSquare]) => ({ node: { flowID, assetURLs: { videoSquare } } })),
      },
    },
  })
}
function textResponse(text: string) {
  return { text: async () => text } as any
}

describe("backfillAllDayEditionVideos — config guard", () => {
  it("returns no_proxy_config when TS_PROXY_URL is unset", async () => {
    delete process.env.TS_PROXY_URL
    const r = await backfillAllDayEditionVideos()
    expect(r).toEqual({ found: 0, written: 0, noVideo: 0, skippedReason: "no_proxy_config" })
  })

  it("returns no_proxy_config when TS_PROXY_SECRET is unset", async () => {
    delete process.env.TS_PROXY_SECRET
    const r = await backfillAllDayEditionVideos()
    expect(r.skippedReason).toBe("no_proxy_config")
  })
})

describe("backfillAllDayEditionVideos — select branches", () => {
  it("surfaces a select error as skippedReason select:<msg>", async () => {
    h.selectResult = { data: null, error: { message: "boom" } }
    const r = await backfillAllDayEditionVideos()
    expect(r).toEqual({ found: 0, written: 0, noVideo: 0, skippedReason: "select:boom" })
  })

  it("returns zeros when no editions are missing video_url", async () => {
    h.selectResult = { data: [], error: null }
    const r = await backfillAllDayEditionVideos()
    expect(r).toEqual({ found: 0, written: 0, noVideo: 0 })
  })
})

describe("backfillAllDayEditionVideos — happy write path", () => {
  it("resolves videos, NULL-only-writes them, and reports found/written/noVideo", async () => {
    // 3 candidate editions; the worker returns a video for 2 of them.
    h.selectResult = { data: [{ external_id: "10" }, { external_id: "20" }, { external_id: "30" }], error: null }
    const fetchSpy = vi.fn(async () =>
      textResponse(edgesBody([[10, "https://cdn.example/10.mp4"], [20, "https://cdn.example/20.mp4"], [30, null]])),
    )
    vi.stubGlobal("fetch", fetchSpy)

    const r = await backfillAllDayEditionVideos()
    expect(r.found).toBe(3)
    expect(r.written).toBe(2)
    expect(r.noVideo).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // 3 ids < 40-per-chunk cap
    // request carries the proxy secret header and the consumer route.
    expect(fetchSpy.mock.calls[0][0]).toBe("https://proxy.example.workers.dev/allday-consumer")
    expect((fetchSpy.mock.calls[0][1] as any).headers["X-Proxy-Secret"]).toBe("s3cr3t")
  })

  it("drops non-integer / out-of-range external_ids before querying the worker", async () => {
    h.selectResult = {
      data: [{ external_id: "notanumber" }, { external_id: "0" }, { external_id: "999999999999" }, { external_id: "7" }],
      error: null,
    }
    const fetchSpy = vi.fn(async () => textResponse(edgesBody([[7, "https://cdn.example/7.mp4"]])))
    vi.stubGlobal("fetch", fetchSpy)

    const r = await backfillAllDayEditionVideos()
    expect(r.found).toBe(1) // only "7" survives the filter
    expect(r.written).toBe(1)
    const sentIds = JSON.parse((fetchSpy.mock.calls[0][1] as any).body).variables.ids
    expect(sentIds).toEqual([7])
  })

  it("counts a write miss (update error) as not-written", async () => {
    h.selectResult = { data: [{ external_id: "10" }], error: null }
    h.updateResult = { error: { message: "conflict" } }
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(edgesBody([[10, "https://cdn.example/10.mp4"]]))))
    const r = await backfillAllDayEditionVideos()
    expect(r.found).toBe(1)
    expect(r.written).toBe(0) // update returned an error → not counted
    expect(r.noVideo).toBe(0)
  })

  it("passes recentDays=0 for a full backlog pass without throwing", async () => {
    h.selectResult = { data: [{ external_id: "10" }], error: null }
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(edgesBody([[10, "https://cdn.example/10.mp4"]]))))
    const r = await backfillAllDayEditionVideos(80, 0)
    expect(r.written).toBe(1)
  })
})

describe("backfillAllDayEditionVideos — fetchChunk retry/error branches", () => {
  it("retries past a Cloudflare JS challenge before succeeding", async () => {
    h.selectResult = { data: [{ external_id: "10" }], error: null }
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(textResponse("Just a moment..."))
      .mockResolvedValueOnce(textResponse(edgesBody([[10, "https://cdn.example/10.mp4"]])))
    vi.stubGlobal("fetch", fetchSpy)
    const r = await backfillAllDayEditionVideos()
    expect(r.written).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("retries on unparseable JSON, then on a network throw, then succeeds", async () => {
    h.selectResult = { data: [{ external_id: "10" }], error: null }
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(textResponse("<<<not json>>>"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(textResponse(edgesBody([[10, "https://cdn.example/10.mp4"]])))
    vi.stubGlobal("fetch", fetchSpy)
    const r = await backfillAllDayEditionVideos()
    expect(r.written).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it("throws when the consumer GraphQL returns an errors array", async () => {
    h.selectResult = { data: [{ external_id: "10" }], error: null }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => textResponse(JSON.stringify({ errors: [{ message: "byEditionFlowIDs invalid" }] }))),
    )
    await expect(backfillAllDayEditionVideos()).rejects.toThrow(/byEditionFlowIDs invalid/)
  })
})
