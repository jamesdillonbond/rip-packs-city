import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/backfill-edition-names.
// Guard: `if (auth !== "Bearer " + INGEST_SECRET_TOKEN) 401`, read at call time,
// before any Cadence/FCL query. A missing or wrong header 401s. We pin the
// fail-closed guard (the happy path runs live Flow Cadence scripts).

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/flow", () => ({ default: { query: async () => ({}) } }))

import { POST } from "@/app/api/backfill-edition-names/route"

const TOKEN = "test-ingest-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/backfill-edition-names", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("POST /api/backfill-edition-names", () => {
  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("401s without an authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })
})
