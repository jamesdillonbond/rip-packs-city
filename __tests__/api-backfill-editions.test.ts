import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for POST /api/backfill-editions.
// The guard is `if (expectedToken && authHeader !== "Bearer TOKEN") 401`, read at
// call time — so with the token SET a wrong/missing header is 401 before the
// TopShot GQL moment walk. The handler takes a plain Request.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => ({}) }))

import { POST } from "@/app/api/backfill-editions/route"

const TOKEN = "test-ingest-token"

function req(auth?: string): Request {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new Request("https://t/api/backfill-editions", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("POST /api/backfill-editions", () => {
  it("401s with a wrong bearer token when the server token is set", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("401s without an authorization header when the server token is set", async () => {
    expect((await POST(req())).status).toBe(401)
  })
})
