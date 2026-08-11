import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"

// Route-integration test for /api/cron/stale-fmv-monitor.
// Auth: Bearer INGEST_SECRET_TOKEN or CRON_SECRET (500 misconfig when token env unset; 401 when set + wrong)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// Success path is SYNCHRONOUS: after auth, the route awaits a Promise.all of 5
// reads (@supabase/supabase-js createClient) — latest FMV computed_at, latest
// sale sold_at, and three editions count(*)s — then returns 200 with a computed
// staleness verdict. The createClient stub is a self-referential chain whose
// thenable resolves a fixture supplying BOTH the latest-row data ({ computed_at,
// sold_at }) and count:0, so a recent computed_at drives status:"ok" and 0
// orphans drives data_integrity_ok:true, all without DB I/O. @/lib/ops-alert is
// stubbed inert (only the stale branch would call it).

const RECENT_ISO = new Date().toISOString()
// Records every .gte() so the bounded-window assertion below can inspect it.
const gteCalls: Array<{ col: string; val: string }> = []
// The five Promise.all reads share one thenable; `resState` lets a test either
// return a single default for every read, OR a sequenced queue (in read order:
// latestFmv, latestSale, editionsCount, orphanSet, orphanPlayer) so distinct
// count/data/error/throw outcomes can be driven per read.
const resState: { def: any; queue: any[] | null; i: number } = {
  def: { data: [{ computed_at: RECENT_ISO, sold_at: RECENT_ISO }], count: 0, error: null },
  queue: null,
  i: 0,
}
const sbChain: any = {
  from: () => sbChain,
  select: () => sbChain,
  order: () => sbChain,
  limit: () => sbChain,
  is: () => sbChain,
  gte: (col: string, val: string) => {
    gteCalls.push({ col, val })
    return sbChain
  },
  then: (resolve: any, reject: any) => {
    const r = resState.queue
      ? resState.queue[Math.min(resState.i++, resState.queue.length - 1)]
      : resState.def
    if (r && r.__reject) return reject(r.__reject)
    return resolve(r)
  },
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sbChain }))
const opsAlert = vi.hoisted(() => ({ sendOpsAlert: vi.fn(async () => {}) }))
vi.mock("@/lib/ops-alert", () => opsAlert)

function resetRes() {
  resState.def = { data: [{ computed_at: RECENT_ISO, sold_at: RECENT_ISO }], count: 0, error: null }
  resState.queue = null
  resState.i = 0
  opsAlert.sendOpsAlert.mockClear()
}

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/stale-fmv-monitor/route")
})

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
  process.env.CRON_SECRET = "test-cron-secret"
  resetRes()
})

describe("GET /api/cron/stale-fmv-monitor", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.GET(makeReq({ method: "GET" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/cron/stale-fmv-monitor — success path (fresh FMV, clean integrity)", () => {
  it("200s with status:'ok' and data_integrity_ok:true when FMV is fresh and no orphans", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.data_integrity_ok).toBe(true)
    expect(body.editions_no_set).toBe(0)
    expect(body.fmv_threshold_minutes).toBe(45)
  })
})

// Regression guard for the 2026-08-04 504. The route was red on 6 of the RPC Ops
// Monitor's last 8 runs — all 3 retries exhausted — because the latest-sale read
// was an UNBOUNDED `ORDER BY sold_at DESC LIMIT 1` over partitioned `sales`. No
// partition has a sold_at-LEADING index, so Postgres read ~4.7M rows across 8
// partitions (measured 17,067 ms / 336,469 buffers) and blew the 30s lambda,
// leaving FMV staleness unmonitored. Bounding sold_at makes the partition key
// prunable and drops it to ~1,993 ms.
//
// This asserts the BOUND EXISTS, which is the property that keeps the route inside
// its budget — not a wall-clock number, which on this instance swings with I/O
// contention and would be a flaky assertion.
describe("stale-fmv-monitor — the latest-sale read stays bounded", () => {
  it("applies a sold_at lower bound so partition pruning can work", async () => {
    gteCalls.length = 0
    await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))

    const soldAtBound = gteCalls.find((c) => c.col === "sold_at")
    expect(soldAtBound, "no sold_at lower bound — the sales read is unbounded again").toBeDefined()

    // The bound must be a recent, sane cutoff. A window that silently widened to
    // months would reintroduce the full-partition scan without failing anything else.
    const ageDays = (Date.now() - new Date(soldAtBound!.val).getTime()) / 86400_000
    expect(ageDays).toBeGreaterThan(0)
    expect(ageDays).toBeLessThanOrEqual(7)
  })

  it("reports the window alongside the age so null is interpretable", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    const body = await res.json()
    // null last_sale_age_minutes means "no sale in the window", not "unknown" —
    // shipping the window is what makes those distinguishable to a consumer.
    expect(typeof body.last_sale_window_days).toBe("number")
    expect(body.last_sale_window_days).toBeGreaterThan(0)
  })
})

describe("GET /api/cron/stale-fmv-monitor — degrade + alert branches", () => {
  it("500s when INGEST_SECRET_TOKEN is unset (server misconfigured)", async () => {
    const saved = process.env.INGEST_SECRET_TOKEN
    delete process.env.INGEST_SECRET_TOKEN
    try {
      const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer whatever" }))
      expect(res.status).toBe(500)
      expect((await res.json()).error).toContain("INGEST_SECRET_TOKEN")
    } finally {
      process.env.INGEST_SECRET_TOKEN = saved
    }
  })

  it("returns status:'stale' and pages ops when FMV is older than the threshold", async () => {
    const OLD = new Date(Date.now() - 200 * 60_000).toISOString() // 200 min > 45
    resState.def = { data: [{ computed_at: OLD, sold_at: OLD }], count: 0, error: null }
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("stale")
    expect(body.fmv_staleness_minutes).toBeGreaterThan(45)
    expect(opsAlert.sendOpsAlert).toHaveBeenCalledTimes(1)
  })

  it("500s when the latest-FMV read returns an error", async () => {
    resState.queue = [
      { data: null, count: null, error: { message: "fmv read boom" } }, // latestFmv
      { data: [{ sold_at: RECENT_ISO }], count: null, error: null },
      { data: null, count: 0, error: null },
      { data: null, count: 0, error: null },
      { data: null, count: 0, error: null },
    ]
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("fmv read boom")
  })

  it("500s with 'no fmv_snapshots rows' when the latest-FMV read is empty", async () => {
    resState.def = { data: [], count: 0, error: null }
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("no fmv_snapshots rows")
  })

  it("reports data_integrity_ok:false when editions are missing a set/player", async () => {
    resState.queue = [
      { data: [{ computed_at: RECENT_ISO }], count: null, error: null }, // latestFmv fresh
      { data: [{ sold_at: RECENT_ISO }], count: null, error: null }, // latestSale
      { data: null, count: 24000, error: null }, // total editions
      { data: null, count: 2, error: null }, // orphan set > 0
      { data: null, count: 0, error: null }, // orphan player
    ]
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.data_integrity_ok).toBe(false)
    expect(body.editions_no_set).toBe(2)
    expect(body.total_editions).toBe(24000)
  })

  it("carries last_sale_age_minutes:null when no sale landed inside the window", async () => {
    resState.queue = [
      { data: [{ computed_at: RECENT_ISO }], count: null, error: null }, // latestFmv fresh
      { data: [], count: null, error: null }, // latestSale — none in window
      { data: null, count: 24000, error: null },
      { data: null, count: 0, error: null },
      { data: null, count: 0, error: null },
    ]
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.last_sale_age_minutes).toBeNull()
  })

  it("500s (status:'error') when a read rejects, hitting the outer catch", async () => {
    resState.queue = [
      { __reject: new Error("pool timeout") }, // latestFmv rejects -> Promise.all rejects
      { data: [], count: 0, error: null },
      { data: null, count: 0, error: null },
      { data: null, count: 0, error: null },
      { data: null, count: 0, error: null },
    ]
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(500)
    expect((await res.json()).status).toBe("error")
  })
})
