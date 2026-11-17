import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/squeeze-check. Wraps the per-collection exposure RPC
// (lib/insights/squeeze-check.ts). Pins the pre-DB param guards (missing wallet / non-Flow-address / unknown
// collection → 400), the per-collection RPC choice, the rpc-error (500) path, and — the reason this test was
// rewritten 2026-10-27 — the THREE states behind a NULL total: a never-scanned wallet is "not_indexed", a scanned
// empty one is "empty", and a failed state read is "unknown", never "empty".

const state: {
  data: any
  error: any
  rpcCalls: string[]
  bfs: { data: any; error: any }
  bfsCalls: Array<Record<string, unknown>>
} = { data: null, error: null, rpcCalls: [], bfs: { data: null, error: null }, bfsCalls: [] }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => {
      state.rpcCalls.push(name)
      return { data: state.data, error: state.error }
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = { table }
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => {
          filters[c] = v
          return q
        },
        maybeSingle: async () => {
          state.bfsCalls.push(filters)
          return state.bfs
        },
      }
      return q
    },
  },
}))

import { GET } from "@/app/api/public/insights/squeeze-check/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/squeeze-check"
const W = "0xbd94cade097e50ac"
const ALLDAY_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

beforeEach(() => {
  state.data = null
  state.error = null
  state.rpcCalls = []
  state.bfs = { data: null, error: null }
  state.bfsCalls = []
})

describe("GET /api/public/insights/squeeze-check", () => {
  it("400s when wallet is missing", async () => {
    const res = await GET(req(BASE))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet param is required")
  })

  it("400s when wallet is not a Flow address", async () => {
    const res = await GET(req(`${BASE}?wallet=0x123`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Flow address")
  })

  it("400s on an unknown collection with NO rows and no RPC call (never Top Shot's exposure)", async () => {
    state.data = { total_moments: 5, buckets: {} }
    const res = await GET(req(`${BASE}?wallet=${W}&collection=laliga-golazos`))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.summary).toBeUndefined()
    expect(state.rpcCalls).toEqual([])
  })

  it("returns the Top Shot exposure summary on the happy path (collection absent → Top Shot)", async () => {
    state.data = { total_moments: 12, buckets: {} }
    const res = await GET(req(`${BASE}?wallet=${W}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("get_wallet_squeeze_exposure")
    expect(body.meta.collection).toBe("nba-top-shot")
    expect(body.index_state).toBe("indexed")
    expect(body.summary).toEqual({ total_moments: 12, buckets: {} })
    expect(state.bfsCalls).toEqual([])
  })

  it("reads the All Day RPC for collection=nfl-all-day", async () => {
    state.data = { total_moments: 3, buckets: {} }
    const res = await GET(req(`${BASE}?wallet=${W}&collection=nfl-all-day`))
    const body = await res.json()
    expect(state.rpcCalls).toEqual(["get_allday_wallet_squeeze_exposure"])
    expect(body.meta.collection).toBe("nfl-all-day")
    expect(body.index_state).toBe("indexed")
  })

  it("a never-scanned wallet is not_indexed, not empty", async () => {
    state.data = { total_moments: null, buckets: {} }
    state.bfs = { data: null, error: null }
    const res = await GET(req(`${BASE}?wallet=${W}&collection=nfl-all-day`))
    const body = await res.json()
    expect(body.index_state).toBe("not_indexed")
    expect(body.index_state).not.toBe("empty")
    // The state read is scoped to the wallet AND the requested collection.
    expect(state.bfsCalls[0]).toMatchObject({ table: "wallet_backfill_state", wallet_address: W, collection_id: ALLDAY_ID })
  })

  it("a scanned wallet that found 0 moments is empty, with its scan time", async () => {
    state.data = { total_moments: null }
    state.bfs = { data: { last_scanned_at: "2026-10-27T17:00:00Z", last_found_count: 0 }, error: null }
    const body = await (await GET(req(`${BASE}?wallet=${W}&collection=nfl-all-day`))).json()
    expect(body.index_state).toBe("empty")
    expect(body.last_scanned_at).toBe("2026-10-27T17:00:00Z")
  })

  // 10-27 review: before 70d288a20 (07:49 PT, 14:49:25Z) a FAILED walk was recorded as a scan that found 0, so
  // an older found=0 row is not evidence the wallet is empty — 93 of 103 such All Day rows predated the fix.
  it("a found=0 scan recorded before the scan-record fix is not_indexed (re-queued), never empty", async () => {
    state.data = { total_moments: null }
    for (const at of ["2026-10-27T10:00:00Z", "2026-08-18T12:00:00Z", "2026-10-27T14:49:24Z"]) {
      state.bfs = { data: { last_scanned_at: at, last_found_count: 0 }, error: null }
      const body = await (await GET(req(`${BASE}?wallet=${W}&collection=nfl-all-day`))).json()
      expect(body.index_state, at).toBe("not_indexed")
    }
    // the boundary itself is trusted
    state.bfs = { data: { last_scanned_at: "2026-10-27T14:49:25Z", last_found_count: 0 }, error: null }
    expect((await (await GET(req(`${BASE}?wallet=${W}&collection=nfl-all-day`))).json()).index_state).toBe("empty")
  })

  it("a scan that found moments the cache lacks is not_indexed, not empty", async () => {
    state.data = { total_moments: null }
    state.bfs = { data: { last_scanned_at: "2026-10-27T10:00:00Z", last_found_count: 40 }, error: null }
    const body = await (await GET(req(`${BASE}?wallet=${W}`))).json()
    expect(body.index_state).toBe("not_indexed")
  })

  it("a failed state read is unknown, never empty", async () => {
    state.data = { total_moments: null }
    state.bfs = { data: null, error: { message: "boom" } }
    const res = await GET(req(`${BASE}?wallet=${W}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.index_state).toBe("unknown")
    expect(body.index_state).not.toBe("empty")
  })

  it("500s on an RPC error", async () => {
    state.error = { message: "rpc boom" }
    const res = await GET(req(`${BASE}?wallet=${W}`))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("rpc boom")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
