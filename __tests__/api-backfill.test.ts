import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/backfill (TopShot sales backfill).
// The guard is `if (expectedToken && authHeader !== "Bearer TOKEN") 401`, read
// at call time — so with the token SET a wrong/missing header is 401 before the
// TopShot GQL walk. (When the env is unset the guard is intentionally skipped;
// we don't exercise the network happy path.)

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

import { POST } from "@/app/api/backfill/route"

const TOKEN = "test-ingest-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/backfill", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("POST /api/backfill", () => {
  it("401s with a wrong bearer token when the server token is set", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("401s without an authorization header when the server token is set", async () => {
    expect((await POST(req())).status).toBe(401)
  })
})
