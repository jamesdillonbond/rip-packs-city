import { describe, it, expect } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/allday-sales-indexer (on-chain sales cron).
// Auth: Bearer INGEST_SECRET_TOKEN or ?token=, into a module-level TOKEN, checked
// before the triple-storefront scan (`!TOKEN || (bearer!==TOKEN && urlToken!==
// TOKEN)` → 401). Both POST (run) and GET share the guard. The run path does live
// chain I/O, so we pin the fail-closed guard.

import { POST, GET } from "@/app/api/allday-sales-indexer/route"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/allday-sales-indexer", { method: "POST", headers })
}

describe("/api/allday-sales-indexer", () => {
  it("POST 401s without a token", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("POST 401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("GET 401s without a token", async () => {
    expect((await GET(req())).status).toBe(401)
  })
})
