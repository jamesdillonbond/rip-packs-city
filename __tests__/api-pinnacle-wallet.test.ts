import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/pinnacle-wallet.
// Guard: the wallet param must start with "0x" (else 400). Then a Promise.all
// of five RPCs (moments / total-fmv / variant-breakdown / franchise-breakdown /
// best-offer) plus a table read of the serial-premium bands is aggregated. We
// mock @/lib/supabase's rpc dispatcher by name, and its `.from(...).select(...)`
// for the band table, then pin the 400 guard plus a mocked happy path (moments
// array + total FMV + normalized variant/franchise shapes + serial enrichment).

const rpcState: Record<string, { data: any; error: any }> = {}
const tableState: Record<string, { data: unknown; error: unknown }> = {}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => rpcState[name] ?? { data: null, error: null },
    from: (table: string) => ({
      select: async () => tableState[table] ?? { data: [], error: null },
    }),
  },
}))

import { GET } from "@/app/api/pinnacle-wallet/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  for (const k of Object.keys(rpcState)) delete rpcState[k]
  for (const k of Object.keys(tableState)) delete tableState[k]
})

// The live fit (compute_pinnacle_serial_fmv_multipliers, refreshed weekly).
const BANDS = [
  { band: "first", multiplier: 15.7741, is_reliable: true },
  { band: "low5", multiplier: 2.1926, is_reliable: true },
  { band: "low20", multiplier: 1.183, is_reliable: true },
  { band: "normal", multiplier: 1, is_reliable: true },
]

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
    rpcState.get_pinnacle_variant_breakdown = {
      data: [
        { variant: "GOLD", count: 1, total_fmv: 400 },
        { variant: "SILVER", count: 1, total_fmv: 100 },
      ],
      error: null,
    }
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
    // variant breakdown array → Title-Case names with real per-variant total_fmv
    expect(body.variants).toEqual(
      expect.arrayContaining([
        { variant_type: "Gold", count: 1, total_fmv: 400 },
        { variant_type: "Silver", count: 1, total_fmv: 100 },
      ])
    )
    // franchise pin_count → count
    expect(body.franchises).toEqual([{ franchise: "Star Wars", count: 2, total_fmv: 500 }])
    // Pinnacle has no locking concept — null, not 0
    expect(body.lockedFmv).toBeNull()
    expect(body.lockedCount).toBeNull()
    // No Pinnacle offer ingest → best-offer RPC unmocked (returns 0/null) → null tile
    expect(body.bestOfferTotal).toBeNull()
    expect(body.spreadGap).toBeNull()
  })

  it("surfaces bestOfferTotal + spreadGap once the offer RPC returns a total", async () => {
    rpcState.get_wallet_moments_with_fmv = { data: [{ moment_id: "m1" }], error: null }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 500, moment_count: 1 }, error: null }
    rpcState.get_pinnacle_variant_breakdown = { data: [], error: null }
    rpcState.get_pinnacle_franchise_breakdown = { data: [], error: null }
    // get_pinnacle_wallet_best_offer_total returns a scalar numeric.
    rpcState.get_pinnacle_wallet_best_offer_total = { data: 120, error: null }

    const res = await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bestOfferTotal).toBe(120)
    // spreadGap = totalFmv − bestOfferTotal
    expect(body.spreadGap).toBe(380)
  })

  it("keeps bestOfferTotal null when the offer RPC returns 0 (no live offers)", async () => {
    rpcState.get_wallet_moments_with_fmv = { data: [{ moment_id: "m1" }], error: null }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 500, moment_count: 1 }, error: null }
    rpcState.get_pinnacle_variant_breakdown = { data: [], error: null }
    rpcState.get_pinnacle_franchise_breakdown = { data: [], error: null }
    rpcState.get_pinnacle_wallet_best_offer_total = { data: 0, error: null }

    const res = await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))
    const body = await res.json()
    expect(body.bestOfferTotal).toBeNull()
    expect(body.spreadGap).toBeNull()
  })

  // ── Serial-premium enrichment ───────────────────────────────────────────
  // Pinnacle holdings used to be shown at flat render FMV regardless of serial,
  // while Top Shot / All Day rows already carried a serial-adjusted value. The
  // route now applies the fitted model. It must stay ADDITIVE: fmv_usd and every
  // total are untouched, and it must decline rather than guess.
  it("enriches moments with a serial-adjusted estimate without touching FMV or totals", async () => {
    tableState.pinnacle_serial_fmv_multipliers = { data: BANDS, error: null }
    rpcState.get_wallet_moments_with_fmv = {
      data: [
        // #1 of 500 -> `first` band.
        { moment_id: "m1", serial_number: 1, circulation_count: 500, fmv_usd: 10 },
        // #400 of 500 -> `normal`, estimate equals FMV at 1.0x.
        { moment_id: "m2", serial_number: 400, circulation_count: 500, fmv_usd: 10 },
      ],
      error: null,
    }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 20, moment_count: 2 }, error: null }
    rpcState.get_pinnacle_variant_breakdown = { data: [], error: null }
    rpcState.get_pinnacle_franchise_breakdown = { data: [], error: null }

    const body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    const [m1, m2] = body.moments

    expect(m1.serial_band).toBe("first")
    expect(m1.serial_fmv).toBeCloseTo(157.74, 2)
    expect(m2.serial_band).toBe("normal")
    expect(m2.serial_fmv).toBe(10)

    // Additive only — the base FMV and the wallet total are unchanged.
    expect(m1.fmv_usd).toBe(10)
    expect(body.totalFmv).toBe(20)
  })

  it("normalises circulation_count into mint_count so '#serial/mint' can render", async () => {
    tableState.pinnacle_serial_fmv_multipliers = { data: BANDS, error: null }
    rpcState.get_wallet_moments_with_fmv = {
      data: [{ moment_id: "m1", serial_number: 3, circulation_count: 250, fmv_usd: 5 }],
      error: null,
    }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 5, moment_count: 1 }, error: null }
    rpcState.get_pinnacle_variant_breakdown = { data: [], error: null }
    rpcState.get_pinnacle_franchise_breakdown = { data: [], error: null }

    const body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    expect(body.moments[0].mint_count).toBe(250)
  })

  it("declines to estimate below the mint guard and when the band table is empty", async () => {
    // Tiny-mint chase pin: the whole edition is scarce, so a ~15.8x #1 estimate
    // would be absurd. Must be null, not a number.
    tableState.pinnacle_serial_fmv_multipliers = { data: BANDS, error: null }
    rpcState.get_wallet_moments_with_fmv = {
      data: [{ moment_id: "m1", serial_number: 1, circulation_count: 5, fmv_usd: 4500 }],
      error: null,
    }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 4500, moment_count: 1 }, error: null }
    rpcState.get_pinnacle_variant_breakdown = { data: [], error: null }
    rpcState.get_pinnacle_franchise_breakdown = { data: [], error: null }

    let body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    expect(body.moments[0].serial_fmv).toBeNull()

    // Band table unavailable -> no estimate anywhere, and the route still 200s.
    tableState.pinnacle_serial_fmv_multipliers = { data: [], error: null }
    rpcState.get_wallet_moments_with_fmv = {
      data: [{ moment_id: "m1", serial_number: 1, circulation_count: 500, fmv_usd: 10 }],
      error: null,
    }
    const res = await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))
    expect(res.status).toBe(200)
    body = await res.json()
    expect(body.moments[0].serial_fmv).toBeNull()
  })
})
