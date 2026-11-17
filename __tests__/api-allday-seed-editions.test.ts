import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/allday-seed-editions.
// Auth reads INGEST_SECRET_TOKEN at call time: unset → 500 (misconfigured),
// set + wrong token → 401, before any GQL fetch. We pin both fail-closed
// branches (the happy path fans out to the AllDay consumer GQL — network).

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { POST } from "@/app/api/allday-seed-editions/route"

const TOKEN = "test-ingest-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/allday-seed-editions", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("POST /api/allday-seed-editions", () => {
  it("500s when the server token is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req(`Bearer ${TOKEN}`))).status).toBe(500)
  })

  it("401s with a wrong token", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("401s without an authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })
})
