import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/tc-report. Wraps the
// get_wallet_tc_report RPC. Pins the pre-DB param guards (missing wallet /
// non-Flow-address → 400) plus the happy and rpc-error (500) paths, and (2026-10-28) the two additions:
// the NFL All Day squeeze leg (its failure fails only that section) and the report-level index_state, so a
// report built from zero cache rows is never a reading of a wallet we never scanned.

const state: {
  rpcs: Record<string, { data: any; error: any }>
  bfs: { data: any; error: any }
  bfsCalls: Array<Record<string, unknown>>
} = { rpcs: {}, bfs: { data: [], error: null }, bfsCalls: [] }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => state.rpcs[name] ?? { data: null, error: null },
    from: (table: string) => {
      const filters: Record<string, unknown> = { table }
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => {
          filters[c] = v
          return q
        },
        limit: async () => {
          state.bfsCalls.push(filters)
          return state.bfs
        },
        maybeSingle: async () => {
          state.bfsCalls.push(filters)
          return { data: null, error: null }
        },
      }
      return q
    },
  },
}))

import { GET } from "@/app/api/public/insights/tc-report/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/tc-report"
const W = "0xbd94cade097e50ac"
const WALLET_URL = `${BASE}?wallet=${W}`

beforeEach(() => {
  state.rpcs = {}
  state.bfs = { data: [], error: null }
  state.bfsCalls = []
})

describe("GET /api/public/insights/tc-report", () => {
  it("400s when wallet is missing", async () => {
    const res = await GET(req(BASE))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet param is required")
  })

  it("400s when wallet is not a Flow address", async () => {
    const res = await GET(req(`${BASE}?wallet=nonsense`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Flow address")
  })

  it("returns the report on the happy path, indexed, with no state read", async () => {
    state.rpcs.get_wallet_tc_report = { data: { cross_collection: [{ slug: "nba_top_shot", moments: 40 }] }, error: null }
    const res = await GET(req(WALLET_URL))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("get_wallet_tc_report")
    expect(body.report).toEqual({ cross_collection: [{ slug: "nba_top_shot", moments: 40 }] })
    expect(body.index_state).toBe("indexed")
    expect(state.bfsCalls.filter((c) => !("collection_id" in c))).toEqual([])
  })

  it("carries the All Day squeeze leg when it found moments", async () => {
    state.rpcs.get_wallet_tc_report = { data: { cross_collection: [{ slug: "nfl_all_day", moments: 9 }] }, error: null }
    state.rpcs.get_allday_wallet_squeeze_exposure = { data: { total_moments: 9, collection: "nfl_all_day" }, error: null }
    const body = await (await GET(req(WALLET_URL))).json()
    expect(body.allday_squeeze).toEqual({ index_state: "indexed", summary: { total_moments: 9, collection: "nfl_all_day" } })
    expect(body.allday_squeeze_error).toBe(false)
  })

  it("a failed All Day leg fails only that section — the report still answers", async () => {
    state.rpcs.get_wallet_tc_report = { data: { cross_collection: [{ slug: "nba_top_shot", moments: 40 }] }, error: null }
    state.rpcs.get_allday_wallet_squeeze_exposure = { data: null, error: { message: "boom" } }
    const res = await GET(req(WALLET_URL))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.allday_squeeze).toBeNull()
    expect(body.allday_squeeze_error).toBe(true)
    expect(body.report.cross_collection).toHaveLength(1)
  })

  it("an empty rollup with no scan on record is not_indexed, never empty", async () => {
    state.rpcs.get_wallet_tc_report = { data: { cross_collection: [] }, error: null }
    state.bfs = { data: [], error: null }
    const body = await (await GET(req(WALLET_URL))).json()
    expect(body.index_state).toBe("not_indexed")
    expect(state.bfsCalls.some((c) => c.table === "wallet_backfill_state" && c.wallet_address === W && !("collection_id" in c))).toBe(true)
  })

  it("every trusted scan found 0 → empty, with the newest scan time", async () => {
    state.rpcs.get_wallet_tc_report = { data: { cross_collection: [] }, error: null }
    state.bfs = {
      data: [
        { last_scanned_at: "2026-10-27T18:00:00Z", last_found_count: 0 },
        { last_scanned_at: "2026-10-28T09:00:00Z", last_found_count: 0 },
      ],
      error: null,
    }
    const body = await (await GET(req(WALLET_URL))).json()
    expect(body.index_state).toBe("empty")
    expect(body.last_scanned_at).toBe("2026-10-28T09:00:00Z")
  })

  it("a found=0 scan from before the scan-record fix is not evidence of empty", async () => {
    state.rpcs.get_wallet_tc_report = { data: { cross_collection: [] }, error: null }
    state.bfs = {
      data: [
        { last_scanned_at: "2026-10-28T09:00:00Z", last_found_count: 0 },
        { last_scanned_at: "2026-10-20T09:00:00Z", last_found_count: 0 },
      ],
      error: null,
    }
    expect((await (await GET(req(WALLET_URL))).json()).index_state).toBe("not_indexed")
  })

  it("a scan that found moments the cache lacks is not_indexed", async () => {
    state.rpcs.get_wallet_tc_report = { data: { cross_collection: [] }, error: null }
    state.bfs = { data: [{ last_scanned_at: "2026-10-28T09:00:00Z", last_found_count: 12 }], error: null }
    expect((await (await GET(req(WALLET_URL))).json()).index_state).toBe("not_indexed")
  })

  it("a failed state read is unknown, never empty", async () => {
    state.rpcs.get_wallet_tc_report = { data: { cross_collection: [] }, error: null }
    state.bfs = { data: null, error: { message: "boom" } }
    const res = await GET(req(WALLET_URL))
    expect(res.status).toBe(200)
    expect((await res.json()).index_state).toBe("unknown")
  })

  it("500s on an RPC error", async () => {
    state.rpcs.get_wallet_tc_report = { data: null, error: { message: "rpc down" } }
    const res = await GET(req(WALLET_URL))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("rpc down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
