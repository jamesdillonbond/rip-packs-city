import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/allday-wallet-search.
// The body is validated by a zod schema; an invalid/empty input 400s (with an
// empty rows/summary shell) before any Cadence walk. Mock the network-touching
// deps so the module imports cleanly; we pin the validation guard (the happy
// path resolves a wallet + fans out to AllDay GQL/Cadence).

vi.mock("@/lib/flow", () => ({ default: { query: async () => [] } }))
vi.mock("@/lib/allday", () => ({ alldayGraphql: async () => ({}) }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { POST } from "@/app/api/allday-wallet-search/route"

function req(body: any): NextRequest {
  return new NextRequest("https://t/api/allday-wallet-search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/allday-wallet-search", () => {
  it("400s on an empty/invalid body", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.summary.totalMoments).toBe(0)
  })
})
