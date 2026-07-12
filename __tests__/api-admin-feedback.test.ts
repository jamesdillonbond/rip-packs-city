import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/feedback (GET).
// verifyAdminRequest-gated. Reads support_conversations (filtered/ordered) +
// beta_feedback_stats. Happy path with empty tables yields rows:[] and a
// zeroed stats block. Pins the fail-closed 401 and the empty happy path.

vi.mock("@/lib/supabase", () => {
  const result = { data: [], error: null }
  const make = () => {
    const c: any = {}
    for (const m of ["select", "not", "in", "eq", "or", "order", "limit"]) c[m] = () => c
    c.then = (resolve: any) => resolve(result)
    return c
  }
  return { supabaseAdmin: { from: () => make() } }
})

import { GET } from "@/app/api/admin/feedback/route"

const ADMIN = "test-admin-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/feedback", { headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("GET /api/admin/feedback", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    expect((await GET(req(`Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("returns empty rows + zeroed stats when the tables are empty", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await GET(req(`Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.stats.total_open).toBe(0)
    expect(body.stats.open_bugs).toBe(0)
  })
})
