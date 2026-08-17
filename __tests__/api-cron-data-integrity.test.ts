import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET /api/cron/data-integrity.
// Fail-closed auth: the GET handler requires Bearer INGEST_SECRET_TOKEN exactly
// and 401s otherwise before any integrity/security check. Token is read at
// REQUEST time. The checks run INLINE (no after()), so the success path is
// driven by a chainable @supabase/supabase-js stub (the route calls createClient
// itself) plus an inert sendOpsAlert. Fixtures are shaped to a clean/healthy DB
// (0 security violations, 100% FMV coverage, fresh badges) so the body is
// status:"ok" with issue_count:0. We pin the guard, then assert the clean body.

// Mutable per-test config the shared client stub reads at call time. createClient
// is invoked once at module load and the returned object is reused, so mutating
// these fields between tests reconfigures the DB responses for each branch.
const cfg = vi.hoisted(() => ({
  security: { data: [] as any[] | null, error: null as any },
  coverage: {
    data: [{ slug: "nba_top_shot", editions: 100, fmv_editions: 100, coverage_pct: 100 }] as
      | any[]
      | null,
    error: null as any,
  },
  badge: { data: { updated_at: new Date().toISOString() } as any, error: null as any },
  counts: [] as Array<{ count: number | null }>,
  countIdx: 0,
  throwSingle: false,
}))

const alertSpy = vi.hoisted(() => vi.fn(async (_opts: any) => ({ suppressed: false })))

const sb = vi.hoisted(() => {
  const s: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "is", "not"]) s[m] = () => s
  s.single = async () => {
    if (cfg.throwSingle) throw new Error("badge single boom")
    return { data: cfg.badge.data, error: cfg.badge.error }
  }
  s.maybeSingle = async () => ({ data: cfg.badge.data, error: cfg.badge.error })
  s.rpc = async (name: string) => {
    if (name === "get_fmv_coverage") {
      return { data: cfg.coverage.data, error: cfg.coverage.error }
    }
    // check_public_security_invariants
    return { data: cfg.security.data, error: cfg.security.error }
  }
  // Terminal awaited reads (the two editions count queries, in order) resolve to
  // the configured counts; default 0.
  s.then = (resolve: any) => {
    const c = cfg.counts[cfg.countIdx] ?? { count: 0 }
    cfg.countIdx++
    return resolve({ data: [], error: null, count: c.count })
  }
  return s
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))
vi.mock("@/lib/ops-alert", () => ({ sendOpsAlert: alertSpy }))

function resetCfg() {
  cfg.security = { data: [], error: null }
  cfg.coverage = {
    data: [{ slug: "nba_top_shot", editions: 100, fmv_editions: 100, coverage_pct: 100 }],
    error: null,
  }
  cfg.badge = { data: { updated_at: new Date().toISOString() }, error: null }
  cfg.counts = []
  cfg.countIdx = 0
  cfg.throwSingle = false
  alertSpy.mockClear()
}

import { GET } from "@/app/api/cron/data-integrity/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/data-integrity"),
  }) as any

const savedIngest = process.env.INGEST_SECRET_TOKEN
const url = "https://t/api/cron/data-integrity"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  resetCfg()
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("GET /api/cron/data-integrity — auth guards", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("GET /api/cron/data-integrity — success path (inline checks, clean DB)", () => {
  it("200s with status:'ok' and issue_count:0 on a healthy DB", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.issue_count).toBe(0)
    expect(body.issues).toEqual([])
    expect(body.stats.security_invariant_violations).toBe(0)
    expect(body.stats.fmv_coverage_pct).toBe(100)
    expect(typeof body.checked_at).toBe("string")
    expect(alertSpy).not.toHaveBeenCalled()
  })
})

const authedReq = () => makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" })

describe("GET /api/cron/data-integrity — degrade + flag branches", () => {
  it("degrades safely (null, unflagged) when the security-invariant check errors", async () => {
    cfg.security = { data: null, error: { message: "sec boom" } }
    const res = await GET(authedReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.stats.security_invariant_violations).toBeNull()
    expect(body.issues).toEqual([])
  })

  it("flags security-invariant violations and pages ops", async () => {
    cfg.security = { data: [{}, {}], error: null }
    const res = await GET(authedReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("issues_found")
    expect(body.issue_count).toBe(1)
    expect(body.issues[0]).toContain("2 security invariant violation")
    expect(body.stats.security_invariant_violations).toBe(2)
    expect(alertSpy).toHaveBeenCalledTimes(1)
    expect(alertSpy.mock.calls[0][0]).toMatchObject({ key: "data-integrity" })
  })

  it("reports fmv_coverage_pct null when the coverage RPC returns no rows", async () => {
    cfg.coverage = { data: [], error: null }
    const res = await GET(authedReq())
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.stats.fmv_coverage_pct).toBeNull()
  })

  it("reports fmv_coverage_pct null when the coverage RPC errors", async () => {
    cfg.coverage = { data: null, error: { message: "cov boom" } }
    const res = await GET(authedReq())
    const body = await res.json()
    expect(body.stats.fmv_coverage_pct).toBeNull()
  })

  it("flags a broad FMV coverage regression (< 95%)", async () => {
    cfg.coverage = {
      data: [{ slug: "nba_top_shot", editions: 100, fmv_editions: 40, coverage_pct: 40 }],
      error: null,
    }
    const res = await GET(authedReq())
    const body = await res.json()
    expect(body.status).toBe("issues_found")
    expect(body.stats.fmv_coverage_pct).toBe(40)
    expect(body.issues.some((i: string) => i.includes("40%"))).toBe(true)
    expect(alertSpy).toHaveBeenCalledTimes(1)
  })

  it("flags stale badge data (> 72h) and reports the age", async () => {
    cfg.badge = {
      data: { updated_at: new Date(Date.now() - 100 * 3600_000).toISOString() },
      error: null,
    }
    const res = await GET(authedReq())
    const body = await res.json()
    expect(body.status).toBe("issues_found")
    expect(body.stats.badge_data_age_hours).toBeGreaterThanOrEqual(99)
    expect(body.issues.some((i: string) => i.includes("Badge data is"))).toBe(true)
  })

  it("skips the badge check when no badge row / updated_at is present", async () => {
    cfg.badge = { data: null, error: null }
    const res = await GET(authedReq())
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.stats.badge_data_age_hours).toBeUndefined()
  })

  // ⚠ INVERTED, AND THE OLD TITLE WAS THE DEFECT SPELLED OUT: "coalesces null
  // orphan counts to 0". A null count means the read produced no number; reporting
  // it as 0 states "there are no orphans" — a measurement — out of a failed read.
  // The ordering half was correct and is kept.
  //   Unlike the sibling `stale-fmv-monitor` (where the same `?? 0` made
  // `dataIntegrityOk` true and SUPPRESSED an alert), nothing here is gated on these,
  // so this was cosmetic. It is fixed anyway because this file's own convention two
  // blocks up is "on error, reported null, never flagged", and the log line beside
  // it already prints `?? "?"` for an unknown badge age.
  it("passes non-null counts through in order, and reports an unread count as UNKNOWN", async () => {
    cfg.counts = [{ count: 5 }, { count: 7 }]
    const res = await GET(authedReq())
    const body = await res.json()
    expect(body.stats.editions_no_set).toBe(5)
    expect(body.stats.editions_no_player_real).toBe(7)

    resetCfg()
    cfg.counts = [{ count: null }, { count: null }]
    const res2 = await GET(authedReq())
    const body2 = await res2.json()
    expect(body2.stats.editions_no_set).toBeNull()
    expect(body2.stats.editions_no_player_real).toBeNull()
    // ⚠ Still informational: an unreadable orphan count must NOT start flagging an
    // issue, or a transient count failure pages ops on a daily cron.
    expect(body2.status).toBe("ok")
    expect(body2.issue_count).toBe(0)
  })

  it("aggregates multiple issues into one ops page", async () => {
    cfg.security = { data: [{}], error: null }
    cfg.coverage = {
      data: [{ slug: "x", editions: 100, fmv_editions: 10, coverage_pct: 10 }],
      error: null,
    }
    const res = await GET(authedReq())
    const body = await res.json()
    expect(body.status).toBe("issues_found")
    expect(body.issue_count).toBe(2)
    expect(alertSpy).toHaveBeenCalledTimes(1)
    expect(alertSpy.mock.calls[0][0].subject).toContain("2 issue")
  })

  it("500s with status:'error' when a check throws", async () => {
    cfg.throwSingle = true
    const res = await GET(authedReq())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.status).toBe("error")
    expect(body.error).toContain("badge single boom")
  })
})
