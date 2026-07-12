import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for GET /api/backfill-onchain-ids.
// Auth is a ?secret= query param compared to INGEST_SECRET_TOKEN at call time
// (`searchParams.get("secret") !== process.env.INGEST_SECRET_TOKEN` → 401),
// checked before any DB read or TopShot GQL resolution. We pin the fail-closed
// guard (the happy path walks editions + queries the TS proxy — network).

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

import { GET } from "@/app/api/backfill-onchain-ids/route"

const TOKEN = "test-ingest-token"

function req(secret?: string): Request {
  const url = "https://t/api/backfill-onchain-ids" + (secret ? `?secret=${secret}` : "")
  return new Request(url)
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("GET /api/backfill-onchain-ids", () => {
  it("401s without the secret query param", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong secret", async () => {
    expect((await GET(req("wrong"))).status).toBe(401)
  })
})
