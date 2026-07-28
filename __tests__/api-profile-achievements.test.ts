import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for /api/profile/achievements.
// GET is public (?ownerKey required → 400) and reads profile_achievements via a
// chained .from().select().eq().order() on supabaseAdmin. POST is gated by the
// INGEST_SECRET_TOKEN env var (unset → 500) and fans out to an edge-function
// fetch, so we only pin its guards (missing token 500, missing ownerKey 400).

const state: { tables: Record<string, any> } = { tables: {} }

function chain(getResult: () => any): any {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
        return () => b
      },
    }
  )
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (t: string) => chain(() => state.tables[t] ?? { data: [], error: null }),
  },
}))

import { GET, POST } from "@/app/api/profile/achievements/route"

const greq = (url: string) => ({ nextUrl: new URL(url) }) as any
const preq = (body: any) => ({ json: async () => body }) as any

beforeEach(() => {
  state.tables = {}
})

describe("GET /api/profile/achievements", () => {
  it("400s without ownerKey", async () => {
    const res = await GET(greq("https://t/api/profile/achievements"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey required")
  })

  it("returns the achievements list for an ownerKey", async () => {
    state.tables.profile_achievements = {
      data: [{ achievement_key: "first_wallet", tier: 1, progress: 100, unlocked_at: "2026-07-01" }],
      error: null,
    }
    const res = await GET(greq("https://t/api/profile/achievements?ownerKey=trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).achievements).toHaveLength(1)
  })

  it("swallows a DB error into { achievements: [] }", async () => {
    state.tables.profile_achievements = { data: null, error: { message: "db down" } }
    const res = await GET(greq("https://t/api/profile/achievements?ownerKey=trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).achievements).toEqual([])
  })

  it("swallows a thrown query into { achievements: [] } (outer catch)", async () => {
    state.tables.profile_achievements = new Proxy({}, {
      get() {
        throw new Error("boom")
      },
    })
    const res = await GET(greq("https://t/api/profile/achievements?ownerKey=trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).achievements).toEqual([])
  })
})

describe("POST /api/profile/achievements (guards only — happy path fans to an edge fetch)", () => {
  const prev = process.env.INGEST_SECRET_TOKEN
  afterEach(() => {
    if (prev === undefined) delete process.env.INGEST_SECRET_TOKEN
    else process.env.INGEST_SECRET_TOKEN = prev
  })

  it("500s when INGEST_SECRET_TOKEN is not set", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const res = await POST(preq({ ownerKey: "trevor" }))
    expect(res.status).toBe(500)
  })

  it("400s when a token is set but ownerKey is missing", async () => {
    process.env.INGEST_SECRET_TOKEN = "x"
    const res = await POST(preq({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey required")
  })

  it("triggers the edge function and returns its result on success", async () => {
    process.env.INGEST_SECRET_TOKEN = "x"
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ unlocked: 2 }) }))
    vi.stubGlobal("fetch", fetchMock as any)
    const res = await POST(preq({ ownerKey: "trevor" }))
    const body = await res.json()
    expect(body.triggered).toBe(true)
    expect(body.result).toEqual({ unlocked: 2 })
    expect(fetchMock).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it("reports triggered:false with the edge fn's error on a non-ok response", async () => {
    process.env.INGEST_SECRET_TOKEN = "x"
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ error: "edge boom" }) })) as any)
    const res = await POST(preq({ ownerKey: "trevor" }))
    const body = await res.json()
    expect(body.triggered).toBe(false)
    expect(body.error).toBe("edge boom")
    vi.unstubAllGlobals()
  })

  it("reports triggered:false when the edge fetch throws", async () => {
    process.env.INGEST_SECRET_TOKEN = "x"
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down") }) as any)
    const res = await POST(preq({ ownerKey: "trevor" }))
    const body = await res.json()
    expect(body.triggered).toBe(false)
    expect(body.error).toBe("network down")
    vi.unstubAllGlobals()
  })
})
