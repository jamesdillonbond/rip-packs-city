import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"

// Route integration test for GET /api/support-report. Bearer INGEST_SECRET_TOKEN
// gated (also accepts ?token= / x-ingest-token) → fail-closed 401. With the
// token present it aggregates support_conversations into a JSON report. Mocks
// @supabase/supabase-js.

const state: { data: any; error: any } = { data: [], error: null }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b, gte: () => b, not: () => b,
    order: async () => ({ data: state.data, error: state.error }),
  }
  return { createClient: () => ({ from: () => b }) }
})

import { GET } from "@/app/api/support-report/route"

const req = (u: string, headers: Record<string, string> = {}) =>
  ({ nextUrl: new URL(u), headers: new Headers(headers) }) as any

const prev = process.env.INGEST_SECRET_TOKEN
beforeEach(() => { state.data = []; state.error = null; process.env.INGEST_SECRET_TOKEN = "secret" })
afterAll(() => { if (prev === undefined) delete process.env.INGEST_SECRET_TOKEN; else process.env.INGEST_SECRET_TOKEN = prev })

describe("GET /api/support-report", () => {
  it("401s without the bearer token", async () => {
    const res = await GET(req("https://t/api/support-report"))
    expect(res.status).toBe(401)
  })

  it("401s when the expected token is unset (fail-closed)", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const res = await GET(req("https://t/api/support-report", { authorization: "Bearer whatever" }))
    expect(res.status).toBe(401)
  })

  it("returns the aggregated report for an authorized caller", async () => {
    state.data = [
      { session_id: "s1", escalated: false, category: "general", created_at: "2026-07-10T00:00:00Z" },
    ]
    const res = await GET(req("https://t/api/support-report?token=secret"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.totalMessages).toBe(1)
    expect(body.summary.uniqueSessions).toBe(1)
  })
})
