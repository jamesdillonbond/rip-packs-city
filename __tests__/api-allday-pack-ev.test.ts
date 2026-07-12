import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/allday-pack-ev.
// The first guard requires a packListingId in the body (400 otherwise) before
// any AllDay GQL fan-out. Mock @supabase/supabase-js + @/lib/allday so the
// module imports cleanly; we pin the param guard (the happy path fetches live
// pack supply data over GQL).

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/allday", () => ({ alldayGraphql: async () => ({}) }))

import { POST } from "@/app/api/allday-pack-ev/route"

function req(body: any): NextRequest {
  return new NextRequest("https://t/api/allday-pack-ev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/allday-pack-ev", () => {
  it("400s when packListingId is missing", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("packListingId is required")
  })

  it("400s when packListingId is an empty string", async () => {
    expect((await POST(req({ packListingId: "" }))).status).toBe(400)
  })
})
