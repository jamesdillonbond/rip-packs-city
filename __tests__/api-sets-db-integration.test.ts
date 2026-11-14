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
    const res = await GET(get("?wallet=0x0000000000000abc&collection=nope"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Unknown collection")
  })

  it("returns a stable 200 body when the collection has no editions", async () => {
    // Re-pinned 2026-11-14: an empty owned list now asks whether the wallet was
    // ever walked; this premise is an INDEXED wallet (a clean-walk record).
    fx.tables.wmc_clean_walks = { data: [{ wallet_address: "0x0000000000000abc" }] }
    const res = await GET(get("?wallet=0x0000000000000abc&collection=laliga-golazos"))
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
    const res = await GET(get("?wallet=0x0000000000000abc&collection=laliga-golazos"))
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
    const res = await GET(get("?wallet=0x0000000000000abc&collection=laliga-golazos"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe("internal")
    expect(body.error).toBe("Failed to load sets.")
  })
})

// 2026-11-14 — zero owned rows has two meanings. A never-walked wallet and a
// username used to read "0%" on every set; both are now refused with a reason.
describe("GET /api/sets-db — an empty owned list is not a 0% claim", () => {
  function resetTables() {
    for (const k of Object.keys(fx.tables)) delete fx.tables[k]
  }
  const golazosEditions = { data: [{ id: "e1", set_id: "s1", set_name: "S", player_name: "P", tier: "COMMON", thumbnail_url: null, external_id: "x1" }] }

  it("a wallet RPC never walked gets 409 wallet_not_indexed, not 0% of every set", async () => {
    resetTables()
    fx.tables.editions = golazosEditions
    fx.tables.sets = { data: [{ id: "s1", name: "S" }] }
    const res = await GET(get("?wallet=0x00000000000000ff&collection=laliga-golazos"))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("wallet_not_indexed")
    expect(body.sets).toBeUndefined()
  })

  it("a failed index check is an error, never 'not indexed' and never 0%", async () => {
    resetTables()
    fx.tables.editions = golazosEditions
    fx.tables.sets = { data: [{ id: "s1", name: "S" }] }
    fx.tables.wmc_clean_walks = { error: { message: "boom", code: "XX000" } }
    const res = await GET(get("?wallet=0x00000000000000ff&collection=laliga-golazos"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.sets).toBeUndefined()
    expect(body.code).not.toBe("wallet_not_indexed")
  })

  it("CONTROL: an indexed wallet holding none of the collection still answers 0%", async () => {
    resetTables()
    fx.tables.editions = golazosEditions
    fx.tables.sets = { data: [{ id: "s1", name: "S" }] }
    fx.tables.wmc_clean_walks = { data: [{ wallet_address: "0x00000000000000ff" }] }
    const res = await GET(get("?wallet=0x00000000000000ff&collection=laliga-golazos"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sets[0].completionPct).toBe(0)
  })

  it("a username is resolved to its wallet, never matched as an address", async () => {
    resetTables()
    fx.tables.editions = golazosEditions
    fx.tables.sets = { data: [{ id: "s1", name: "S" }] }
    fx.tables.wallet_moments_cache = { data: [{ moment_id: "m1", edition_key: "x1", serial_number: 5, is_locked: false }] }
    fx.tables["rpc:resolve_topshot_username"] = { data: { found: true, wallet_address: "0x00000000000000AA", username: "someone" } }
    const res = await GET(get("?wallet=someone&collection=laliga-golazos"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resolvedAddress).toBe("0x00000000000000aa")
    expect(body.sets[0].completionPct).toBe(100)
  })
})
