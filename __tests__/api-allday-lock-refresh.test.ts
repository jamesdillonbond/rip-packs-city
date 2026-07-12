import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/allday-lock-refresh.
// Guard: `wallet` query param required → 400, before the Cadence unlocked-moment
// query. Mock @/lib/supabase + @/lib/flow so the module imports cleanly; we pin
// the param guard (the happy path diffs on-chain vs cached moment locks).

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/flow", () => ({ default: { query: async () => [] } }))

import { GET } from "@/app/api/allday-lock-refresh/route"

const req = (qs = "") => new NextRequest("https://t/api/allday-lock-refresh" + qs)

describe("GET /api/allday-lock-refresh", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })
})
