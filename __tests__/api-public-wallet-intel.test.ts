import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/wallet-intel. Constructs a module-level
// service-role client via @supabase/supabase-js createClient and wraps the
// get_wallet_intel_summary RPC. Pins the pre-DB Flow-address guard (400), the
// happy path, and the rpc-error → 500 (with the generic client-facing message).

const state: { data: any; error: any } = { data: null, error: null }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async () => ({ data: state.data, error: state.error }) }),
}))

import { GET } from "@/app/api/public/wallet-intel/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/wallet-intel"

beforeEach(() => {
  state.data = null
  state.error = null
})

describe("GET /api/public/wallet-intel", () => {
  it("400s when wallet is missing", async () => {
    const res = await GET(req(BASE))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Flow address")
  })

  it("400s when wallet is not a Flow address", async () => {
    const res = await GET(req(`${BASE}?wallet=0xabc`))
    expect(res.status).toBe(400)
  })

  it("returns the intel object on the happy path", async () => {
    state.data = { rookie_count: 3, trophy_count: 1, highlights: [] }
    const res = await GET(req(`${BASE}?wallet=0xbd94cade097e50ac`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ rookie_count: 3, trophy_count: 1, highlights: [] })
  })

  it("500s with a generic message on an RPC error", async () => {
    state.error = { message: "internal rpc detail" }
    const res = await GET(req(`${BASE}?wallet=0xbd94cade097e50ac`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Failed to fetch wallet intel")
  })
})
