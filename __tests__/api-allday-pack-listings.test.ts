import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/allday-pack-listings.
// POST is `auth !== "Bearer " + INGEST_SECRET_TOKEN` gated before after()-
// deferred work — pin the fail-closed guard. GET is read-only: a
// get_pack_listings_by_collection RPC mapped into the listings payload. Mock
// @supabase/supabase-js for the GET happy + error branches.

const rpc: { data: any; error: any } = { data: [], error: null }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async () => ({ data: rpc.data, error: rpc.error }) }),
}))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

import { POST, GET } from "@/app/api/allday-pack-listings/route"

const TOKEN = "test-ingest-token"

function postReq(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/allday-pack-listings", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  rpc.data = []
  rpc.error = null
})

describe("/api/allday-pack-listings", () => {
  it("POST 401s without a token", async () => {
    expect((await POST(postReq())).status).toBe(401)
  })

  it("POST 401s with a wrong token", async () => {
    expect((await POST(postReq("Bearer wrong"))).status).toBe(401)
  })

  it("GET maps RPC rows into the listings payload", async () => {
    rpc.data = [
      { id: "allday:x", pack_name: "Base — RARE", tier: "RARE", lowest_ask_usd: 12, total_listed: 3 },
    ]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings).toHaveLength(1)
    expect(body.listings[0].tier).toBe("rare")
    expect(body.listings[0].lowestAsk).toBe(12)
  })

  // ⚠ INVERTED 2026-08-22, not deleted. This asserted `listings: []` IN THE ERROR
  // BODY — an empty answer packaged alongside the failure, on an anon-reachable
  // product route. A passing test asserting a promise is what holds that promise
  // in place, so the assertion is reversed rather than removed.
  it("GET fails without shipping an empty listings array alongside the error", async () => {
    rpc.error = { message: "db down" }
    const res = await GET()
    expect(res.ok).toBe(false)
    const body = await res.json()
    expect(body.listings).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("db down")
  })
})
