import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/pinnacle-wallet.
// Guard: the wallet param must start with "0x" (else 400). Then a Promise.all
// of four RPCs (moments / total-fmv / variant-counts / franchise-breakdown) is
// aggregated. We mock @/lib/supabase's rpc dispatcher by name and pin the 400
// guard plus a mocked happy path (moments array + total FMV + normalized
// variant/franchise shapes).

const rpcState: Record<string, { data: any; error: any }> = {}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => rpcState[name] ?? { data: null, error: null },
  },
}))

import { GET } from "@/app/api/pinnacle-wallet/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  for (const k of Object.keys(rpcState)) delete rpcState[k]
})

describe("GET /api/pinnacle-wallet", () => {
  it("400s when the wallet param is missing", async () => {
    const res = await GET(req("https://t/api/pinnacle-wallet"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet param required")
  })

  it("400s when the wallet does not start with 0x", async () => {
    const res = await GET(req("https://t/api/pinnacle-wallet?wallet=abc123"))
    expect(res.status).toBe(400)
  })

  it("aggregates the four RPCs for a valid wallet", async () => {
    rpcState.get_wallet_moments_with_fmv = { data: [{ moment_id: "m1" }, { moment_id: "m2" }], error: null }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 500, moment_count: 2 }, error: null }
    rpcState.get_pinnacle_variant_counts = { data: { GOLD: 1, SILVER: 1 }, error: null }
    rpcState.get_pinnacle_franchise_breakdown = {
      data: [{ franchise: "Star Wars", pin_count: 2, total_fmv: 500 }],
      error: null,
    }

    const res = await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.wallet).toBe("0xabc") // lower-cased
    expect(body.moments).toHaveLength(2)
    expect(body.momentCount).toBe(2)
    expect(body.totalFmv).toBe(500)
    // variant object → array with Title-Case names
    expect(body.variants).toEqual(
      expect.arrayContaining([{ variant_type: "Gold", count: 1, total_fmv: null }])
    )
    // franchise pin_count → count
    expect(body.franchises).toEqual([{ franchise: "Star Wars", count: 2, total_fmv: 500 }])
    // Pinnacle has no locking concept — null, not 0
    expect(body.lockedFmv).toBeNull()
    expect(body.lockedCount).toBeNull()
  })
})
