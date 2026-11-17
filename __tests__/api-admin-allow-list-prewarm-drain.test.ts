import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/allow-list/prewarm-drain. Gated on
// CRON_SECRET (not RPC_ADMIN_TOKEN): a missing secret is a 500 misconfig, a wrong
// bearer is a 401. Beyond the guards this drives the captured after() body — the
// per-row poll-budget arithmetic (full cap for a single row, degraded for a
// 5-row burst) and, most importantly, the throw path: a row whose processor
// throws must be marked `failed` via allow_list_finish_prewarm rather than left
// stuck `in_progress` where no future claim cycle would pick it up.

const st = vi.hoisted(() => ({
  claim: { data: [] as any[] | null, error: null as any },
  finishCalls: [] as any[],
  processed: [] as Array<{ row: any; origin: string; opts: any }>,
  throwOnIds: new Set<string>(),
  captured: null as null | (() => Promise<void>),
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { st.captured = fn } }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: any) => {
      if (name === "allow_list_finish_prewarm") { st.finishCalls.push(args); return { data: null, error: null } }
      return st.claim
    },
  },
}))
vi.mock("@/lib/allow-list/prewarm", () => ({
  processSinglePrewarmRow: async (row: any, origin: string, opts: any) => {
    st.processed.push({ row, origin, opts })
    if (st.throwOnIds.has(row.id)) throw new Error("seeder blew up")
    return { id: row.id, finish_status: "done", welcome_sent: true }
  },
}))

import { POST } from "@/app/api/admin/allow-list/prewarm-drain/route"

const URL_ = "https://rippackscity.com/api/admin/allow-list/prewarm-drain"
const authed = () => adminReq(URL_, { authorization: "Bearer cron-secret" })

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret"
  st.claim = { data: [], error: null }
  st.finishCalls = []
  st.processed = []
  st.throwOnIds = new Set()
  st.captured = null
})
afterEach(() => { delete process.env.CRON_SECRET })

describe("POST /api/admin/allow-list/prewarm-drain — guards", () => {
  it("500s when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET
    const res = await POST(adminReq(URL_))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("CRON_SECRET not configured")
  })
  it("401s when the bearer does not match CRON_SECRET", async () => {
    const res = await POST(adminReq(URL_, { authorization: "Bearer wrong" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("unauthorized")
  })
  it("500s when the claim RPC errors", async () => {
    st.claim = { data: null, error: { message: "claim down" } }
    const res = await POST(authed())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("claim down")
  })
  it("202s claiming 0 rows on an empty queue and schedules no work", async () => {
    const res = await POST(authed())
    expect(res.status).toBe(202)
    expect((await res.json()).claimed).toBe(0)
    expect(st.captured).toBeNull() // after() never scheduled for an empty claim
  })
})

describe("POST /api/admin/allow-list/prewarm-drain — deferred drain", () => {
  it("202s with the claimed count and processes each row against the request origin", async () => {
    st.claim = { data: [{ id: "r1", email: "a@b.co" }], error: null }
    const res = await POST(authed())
    expect(res.status).toBe(202)
    expect((await res.json()).claimed).toBe(1)

    await st.captured!()
    expect(st.processed).toHaveLength(1)
    expect(st.processed[0].origin).toBe("https://rippackscity.com")
  })

  it("gives a single-row claim the full 150s poll cap", async () => {
    st.claim = { data: [{ id: "r1" }], error: null }
    await POST(authed())
    await st.captured!()
    expect(st.processed[0].opts.pollBudgetMs).toBe(150_000)
  })

  it("degrades the per-row budget on a full 5-row burst (never exceeds the deadline)", async () => {
    st.claim = { data: [1, 2, 3, 4, 5].map((n) => ({ id: `r${n}` })), error: null }
    await POST(authed())
    await st.captured!()
    expect(st.processed).toHaveLength(5)
    // 270s budget / 5 rows − 60s reserve ≈ 0 → clamped at 0, well under the cap
    expect(st.processed[0].opts.pollBudgetMs).toBeLessThan(150_000)
    for (const p of st.processed) expect(p.opts.pollBudgetMs).toBeGreaterThanOrEqual(0)
  })

  it("marks a throwing row failed so it is never left stuck in_progress", async () => {
    st.claim = { data: [{ id: "r1" }, { id: "r2" }], error: null }
    st.throwOnIds = new Set(["r1"])
    await POST(authed())
    await st.captured!()

    expect(st.finishCalls).toHaveLength(1)
    expect(st.finishCalls[0]).toMatchObject({ p_id: "r1", p_status: "failed" })
    expect(st.finishCalls[0].p_error).toContain("unhandled: seeder blew up")
    // the throw must not abort the rest of the batch
    expect(st.processed.map((p) => p.row.id)).toEqual(["r1", "r2"])
  })

  it("never throws out of after() even when every row fails", async () => {
    st.claim = { data: [{ id: "r1" }], error: null }
    st.throwOnIds = new Set(["r1"])
    await POST(authed())
    await expect(st.captured!()).resolves.toBeUndefined()
  })
})
