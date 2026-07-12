import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/bulk-classify (SSE classifier).
// Auth is a ?token= query param compared to a module-level INGEST_TOKEN
// (`!INGEST_TOKEN || token !== INGEST_TOKEN` → 401), checked before the stream
// opens. With the env unset at import the token is empty, so every request 401s.
// We pin the fail-closed guard (the run path streams live TopShot GQL work).

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { GET } from "@/app/api/bulk-classify/route"

function req(token?: string): NextRequest {
  const url = "https://t/api/bulk-classify" + (token ? `?token=${token}` : "")
  return new NextRequest(url)
}

describe("GET /api/bulk-classify", () => {
  it("401s without a token", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong token", async () => {
    expect((await GET(req("wrong"))).status).toBe(401)
  })
})
