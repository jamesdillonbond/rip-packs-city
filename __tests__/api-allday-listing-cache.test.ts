import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/allday-listing-cache.
// NOTE: the module THROWS at import time unless FLOWTY_PROXY_TOKEN is set, so we
// set it before the dynamic import. Auth: Bearer INGEST_SECRET_TOKEN or ?token=
// into a module-level TOKEN, checked on both GET and POST before the Flowty
// pipeline runs (`!TOKEN || (bearer!==TOKEN && urlToken!==TOKEN)` → 401). We pin
// the fail-closed guard.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

process.env.FLOWTY_PROXY_TOKEN = "test-flowty-token"

const { GET, POST } = await import("@/app/api/allday-listing-cache/route")

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/allday-listing-cache", { method: "POST", headers })
}

describe("/api/allday-listing-cache", () => {
  it("GET 401s without a token", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("POST 401s without a token", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("POST 401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })
})
