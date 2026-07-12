import { describe, it, expect } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/allday-listings-retry (resolution-retry cron).
// Auth: strict Bearer INGEST_SECRET_TOKEN into a module-level TOKEN
// (`auth !== "Bearer TOKEN"` → 401) before draining the failure queue. The run
// path does live Flow REST work, so we pin the fail-closed guard on POST (and
// GET, which shares it).

import { POST, GET } from "@/app/api/allday-listings-retry/route"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/allday-listings-retry", { method: "POST", headers })
}

describe("/api/allday-listings-retry", () => {
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
