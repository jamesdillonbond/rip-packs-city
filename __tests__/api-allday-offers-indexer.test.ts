import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/allday-offers-indexer.
// POST is Bearer INGEST_SECRET_TOKEN (or ?token=) gated into a module-level TOKEN
// before any on-chain scan — pin the fail-closed guard. GET is read-only (a
// count of edition_offers rows); mock @/lib/supabase to exercise the happy +
// error branches.

const state: { count: number; error: any } = { count: 0, error: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    from: () => b,
    select: () => b,
    eq: async () => ({ count: state.count, error: state.error }),
  }
  return { supabaseAdmin: b }
})

import { POST, GET } from "@/app/api/allday-offers-indexer/route"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/allday-offers-indexer", { method: "POST", headers })
}

beforeEach(() => {
  state.count = 0
  state.error = null
})

describe("/api/allday-offers-indexer", () => {
  it("POST 401s without a token", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("POST 401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("GET returns the open-offer row count", async () => {
    state.count = 57
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.allDayOfferRows).toBe(57)
  })

  it("GET 500s on a query error", async () => {
    state.error = { message: "db down" }
    expect((await GET()).status).toBe(500)
  })
})
