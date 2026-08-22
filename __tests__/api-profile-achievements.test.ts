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

// POST is now ownership-gated (deep-audit R13): it used to take `ownerKey` from
// the BODY and call the edge function with the server's INGEST_SECRET_TOKEN, so
// any caller could make RPC recompute and WRITE achievements for an arbitrary
// owner_key using our own operator credential. `ownedKeyGate` lets each case
// choose whether the caller owns the key.
const ownedKeyGate: { deny: Response | null } = { deny: null }
vi.mock("@/lib/auth/owner-key-guard", () => ({
  requireOwnedKey: async () =>
    ownedKeyGate.deny ?? { user: { id: "user-1" } },
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

  // ⚠ These two cases used to be titled "swallows a DB error into
  // { achievements: [] }" and asserted a 200 with an empty array — pinning the
  // defect as the contract (deep-audit R13). An empty array at 200 is
  // byte-identical to "you have unlocked nothing", so an outage silently erased
  // a collector's achievements from their own profile. Rewritten to assert the
  // property that matters: a failed read is reported as a failure, and the
  // driver's own message never reaches the body.
  it("reports a DB error as a failure, not as zero achievements", async () => {
    state.tables.profile_achievements = { data: null, error: { message: "db down" } }
    const res = await GET(greq("https://t/api/profile/achievements?ownerKey=trevor"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.achievements).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("db down")
  })

  it("reports a thrown query as a failure (outer catch)", async () => {
    state.tables.profile_achievements = new Proxy({}, {
      get() {
        throw new Error("boom")
      },
    })
    const res = await GET(greq("https://t/api/profile/achievements?ownerKey=trevor"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.achievements).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("boom")
  })

  it("a genuinely empty set is still an honest 200 with []", async () => {
    // The opposite direction: the fix must not turn "no achievements yet" into
    // an error, or it trades one false claim for another.
    state.tables.profile_achievements = { data: [], error: null }
    const res = await GET(greq("https://t/api/profile/achievements?ownerKey=trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).achievements).toEqual([])
  })
})

describe("POST /api/profile/achievements (guards only — happy path fans to an edge fetch)", () => {
  const prev = process.env.INGEST_SECRET_TOKEN
  beforeEach(() => {
    ownedKeyGate.deny = null
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.INGEST_SECRET_TOKEN
    else process.env.INGEST_SECRET_TOKEN = prev
  })

  it("refuses an ownerKey the caller does not own, and never reaches the edge fn", async () => {
    process.env.INGEST_SECRET_TOKEN = "x"
    ownedKeyGate.deny = new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock as any)
    const res = await POST(preq({ ownerKey: "someone-elses-key" }))
    expect(res.status).toBe(403)
    // The operator credential must never be spent on an unowned key.
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("refuses an unauthenticated caller", async () => {
    process.env.INGEST_SECRET_TOKEN = "x"
    ownedKeyGate.deny = new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock as any)
    const res = await POST(preq({ ownerKey: "trevor" }))
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
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

  // ⚠ INVERTED 2026-08-22, not deleted — it pinned TWO defects as the contract.
  // The old assertions were `triggered === false` on an HTTP 200, plus
  // `error === "network down"`: a FAILED recompute reported as a successful
  // request that simply triggered nothing, with the raw message attached. Any
  // consumer checking `r.ok` read "succeeded". A passing test asserting a
  // promise is what holds that promise in place, so this is reversed in place.
  it("fails loudly, and without leaking the message, when the edge fetch throws", async () => {
    process.env.INGEST_SECRET_TOKEN = "x"
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down") }) as any)
    const res = await POST(preq({ ownerKey: "trevor" }))
    // A failed recompute must NOT look like a completed one.
    expect(res.ok).toBe(false)
    const body = await res.json()
    expect(body.triggered).not.toBe(false)
    expect(JSON.stringify(body)).not.toContain("network down")
    vi.unstubAllGlobals()
  })
})
