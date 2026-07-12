import { describe, it, expect } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/allday-fmv-populate (cursor-sweep cron).
// Auth: Bearer INGEST_SECRET_TOKEN or ?token=, read into a module-level TOKEN.
// The guard is `authed = !!TOKEN && (bearer==="Bearer TOKEN" || urlToken===TOKEN)`,
// so a missing/empty server token or a wrong caller token → 401 before any GQL
// fan-out. The happy path pages the live AllDay marketplace GQL (network), so we
// pin only the fail-closed guard.

import { GET } from "@/app/api/allday-fmv-populate/route"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/allday-fmv-populate", { headers })
}

describe("GET /api/allday-fmv-populate", () => {
  it("401s without an authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})
