import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for GET /api/sets-db (generic DB-driven sets feed).
// Reads editions + sets + wallet_moments_cache; makeSupabaseFixture's empty
// default drives the full assembly to a stable SetsResponse, plus the two
// required-param / unknown-collection guards.

// The error-path suite mutates this to inject a builder that surfaces an error,
// exercising the catch → safeApiError classification.
const fx = vi.hoisted(() => ({ tables: {} as Record<string, { data?: unknown; error?: unknown }> }))

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: makeSupabaseFixture(fx.tables) }))

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

describe("GET /api/sets-db — error classification", () => {
  // fx.tables is bound to the singleton fixture at mock-init, so mutate in place.
  function resetTables() {
    for (const k of Object.keys(fx.tables)) delete fx.tables[k]
  }

  it("returns a 503 + Retry-After for a transient DB timeout (never leaks the driver text)", async () => {
    resetTables()
    // fetchAllPaged over `editions` throws the injected error -> caught -> classified timeout.
    Object.assign(fx.tables, {
      editions: { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } },
    })
    const res = await GET(get("?wallet=0xabc&collection=laliga-golazos"))
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("60")
    const body = await res.json()
    // safe copy, not the raw Postgres message
    expect(body.error).not.toContain("statement timeout")
    expect(body.code).toBe("timeout")
    expect(body.retryable).toBe(true)
  })

  it("returns a generic 500 for an unclassified error", async () => {
    resetTables()
    Object.assign(fx.tables, {
      editions: { data: null, error: { message: "some unexpected failure" } },
    })
    const res = await GET(get("?wallet=0xabc&collection=laliga-golazos"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe("internal")
    expect(body.error).toBe("Failed to load sets.")
  })
})
