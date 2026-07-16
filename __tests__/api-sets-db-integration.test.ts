import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for GET /api/sets-db (generic DB-driven sets feed).
// Reads editions + sets + wallet_moments_cache; makeSupabaseFixture's empty
// default drives the full assembly to a stable SetsResponse, plus the two
// required-param / unknown-collection guards.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: makeSupabaseFixture({}) }))

const { GET } = await import("@/app/api/sets-db/route")
const get = (qs: string) => new NextRequest(`https://t/api/sets-db${qs}`)

describe("GET /api/sets-db — integration", () => {
  it("400s when the wallet param is missing", async () => {
    const res = await GET(get("?collection=laliga-golazos"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("400s on an unknown collection slug", async () => {
    const res = await GET(get("?wallet=0xabc&collection=nope"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Unknown collection")
  })

  it("returns a stable 200 body when the collection has no editions", async () => {
    const res = await GET(get("?wallet=0xabc&collection=laliga-golazos"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error).toBeUndefined()
    expect(Array.isArray(body.sets)).toBe(true)
  })
})
