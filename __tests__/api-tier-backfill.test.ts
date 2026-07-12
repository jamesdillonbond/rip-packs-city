import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/tier-backfill. A wallet_moments_cache tier
// backfill sweep gated by ?token= against INGEST_SECRET_TOKEN → fail-closed 401
// when the token is missing/mismatched (unset expected token in-test). Mocks
// @supabase/supabase-js so module construction succeeds.

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ select: () => ({}) }) }),
}))

import { GET } from "@/app/api/tier-backfill/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

describe("GET /api/tier-backfill", () => {
  it("401s without a matching token (fail-closed)", async () => {
    expect((await GET(req("https://t/api/tier-backfill"))).status).toBe(401)
    expect((await GET(req("https://t/api/tier-backfill?token=wrong"))).status).toBe(401)
  })
})
