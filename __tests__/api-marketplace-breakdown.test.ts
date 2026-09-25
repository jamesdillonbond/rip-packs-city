import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/marketplace-breakdown (GET). No auth. Wraps
// get_marketplace_breakdown(p_wallet, p_collection_id). Mocks @/lib/supabase
// supabaseAdmin.rpc. Pins the missing-wallet 400, the array-first happy path,
// and rpc error → 500.

const rpc: { data: any; error: any } = { data: null, error: null }

const seen: { args: any } = { args: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async (_n: string, args: any) => { seen.args = args; return { data: rpc.data, error: rpc.error } } },
}))

import { GET } from "@/app/api/marketplace-breakdown/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  rpc.data = null
  rpc.error = null
})

describe("GET /api/marketplace-breakdown", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/marketplace-breakdown"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("returns the first row of the rpc result array", async () => {
    rpc.data = [{ total: 5 }, { total: 99 }]
    const res = await GET(req("https://t/api/marketplace-breakdown?wallet=0xabc"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ total: 5 })
  })

  // 2026-09-25 — a named collection is resolved or refused, never Top Shot's.
  it("resolves a `collection` slug to its uuid", async () => {
    rpc.data = [{ total: 1 }]
    await GET(req("https://t/api/marketplace-breakdown?wallet=0xabc&collection=nfl-all-day"))
    expect(seen.args.p_collection_id).toBe("dee28451-5d62-409e-a1ad-a83f763ac070")
  })
  it("refuses an unknown `collection` slug with 400 and never asks the RPC", async () => {
    seen.args = null
    const res = await GET(req("https://t/api/marketplace-breakdown?wallet=0xabc&collection=settings"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("collection_not_supported")
    expect(seen.args).toBeNull()
  })
  it("no-change control: no collection at all still defaults to Top Shot", async () => {
    rpc.data = [{ total: 1 }]
    await GET(req("https://t/api/marketplace-breakdown?wallet=0xabc"))
    expect(seen.args.p_collection_id).toBe("95f28a17-224a-4025-96ad-adf8a4c63bfd")
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db down" }
    const res = await GET(req("https://t/api/marketplace-breakdown?wallet=abc"))
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("db down")
  })
})
