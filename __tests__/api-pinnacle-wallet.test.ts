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
// Set to an RPC name to make the mock throw for it -> exercises the top-level
// catch (Promise.all rejects → 500).
const control: { throwRpc: string | null } = { throwRpc: null }

const resolver = { result: null as string | null, calls: [] as string[] }
vi.mock("@/lib/chains/flow/topshot-username-resolve", async (orig) => {
  const real = await orig<typeof import("@/lib/chains/flow/topshot-username-resolve")>()
  return { ...real, lookupCachedTopShotUsername: async (_c: unknown, u: string) => { resolver.calls.push(u); return resolver.result } }
})

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => {
      if (control.throwRpc && name === control.throwRpc) throw new Error("promise-all boom")
      return rpcState[name] ?? { data: null, error: null }
    },
    // `select` returns a thenable that ALSO carries `.in(...)`, so both the bare
    // `.from(t).select(c)` band read AND the `.from(t).select(c).in(col, vals)`
    // pinnacle_editions read in fetchEditionTypes resolve to the table payload.
    from: (table: string) => ({
      select: () => {
        const result = tableState[table] ?? { data: [], error: null }
        return {
          in: async () => result,
          then: (resolve: any) => resolve(result),
        }
      },
    }),
  },
}))

import { GET } from "@/app/api/pinnacle-wallet/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  for (const k of Object.keys(rpcState)) delete rpcState[k]
  for (const k of Object.keys(tableState)) delete tableState[k]
  control.throwRpc = null
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

  // 2026-09-06: a USERNAME is not a malformed wallet — the front door tells
  // readers to paste one. It resolves through the cached ladder; unresolved is
  // a 404 with actionable copy, never `400 wallet param required` on screen.
  it("resolves a Top Shot username through the cached ladder before reading", async () => {
    resolver.result = "0xb5081692483c2336"
    rpcState.get_wallet_moments_with_fmv = { data: [{ moment_id: "m1" }], error: null }
    const res = await GET(req("https://t/api/pinnacle-wallet?wallet=jamesdillonbond"))
    expect(res.status).toBe(200)
    expect(resolver.calls).toEqual(["jamesdillonbond"])
  })

  it("404s (not 400) when a username does not resolve — and never reads the RPCs", async () => {
    resolver.result = null
    const res = await GET(req("https://t/api/pinnacle-wallet?wallet=abc123"))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("unresolved")
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

  // ── moments-envelope shapes ─────────────────────────────────────────────
  it("unwraps the { moments: [...] } envelope shape", async () => {
    rpcState.get_wallet_moments_with_fmv = { data: { moments: [{ moment_id: "m1" }, { moment_id: "m2" }] }, error: null }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 50, moment_count: 2 }, error: null }
    const body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    expect(body.moments).toHaveLength(2)
  })

  it("unwraps the { data: [...] } envelope shape", async () => {
    rpcState.get_wallet_moments_with_fmv = { data: { data: [{ moment_id: "m1" }] }, error: null }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 5, moment_count: 1 }, error: null }
    const body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    expect(body.moments).toHaveLength(1)
  })

  it("falls back to an empty moments list for an unrecognised envelope", async () => {
    rpcState.get_wallet_moments_with_fmv = { data: {}, error: null }
    // total RPC unmocked -> totalJson {} -> totalFmv null, momentCount -> moments.length (0)
    const body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    expect(body.moments).toEqual([])
    expect(body.totalFmv).toBeNull()
    expect(body.momentCount).toBe(0)
  })

  // ── total-FMV coercion shapes ───────────────────────────────────────────
  it("reads a bare-number total and derives momentCount from moments.length", async () => {
    rpcState.get_wallet_moments_with_fmv = { data: [{ moment_id: "m1" }, { moment_id: "m2" }], error: null }
    rpcState.get_pinnacle_wallet_total_fmv = { data: 321, error: null }
    const body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    expect(body.totalFmv).toBe(321)
    // total is a bare number -> no moment_count/count field -> falls to moments.length
    expect(body.momentCount).toBe(2)
  })

  it("reads the fmv_total total alias and the count alias", async () => {
    rpcState.get_wallet_moments_with_fmv = { data: [{ moment_id: "m1" }], error: null }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { fmv_total: 77, count: 9 }, error: null }
    const body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    expect(body.totalFmv).toBe(77)
    expect(body.momentCount).toBe(9)
  })

  // ── variant / franchise normalisation edges ─────────────────────────────
  it("nulls a variant total_fmv that is absent and normalises franchise count/franchise aliases", async () => {
    rpcState.get_wallet_moments_with_fmv = { data: [], error: null }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 0, moment_count: 0 }, error: null }
    rpcState.get_pinnacle_variant_breakdown = { data: [{ variant: "GOLD", count: 2 }], error: null }
    // franchise carries `count` (not pin_count) and no franchise name -> "Unknown"
    rpcState.get_pinnacle_franchise_breakdown = { data: [{ count: 4 }], error: null }
    const body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    expect(body.variants).toEqual([{ variant_type: "Gold", count: 2, total_fmv: null }])
    expect(body.franchises).toEqual([{ franchise: "Unknown", count: 4, total_fmv: null }])
  })

  it("tolerates non-array variant/franchise RPC payloads", async () => {
    rpcState.get_wallet_moments_with_fmv = { data: [], error: null }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 0, moment_count: 0 }, error: null }
    rpcState.get_pinnacle_variant_breakdown = { data: { oops: true }, error: null }
    rpcState.get_pinnacle_franchise_breakdown = { data: null, error: null }
    const body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    expect(body.variants).toEqual([])
    expect(body.franchises).toEqual([])
  })

  // ── edition-type serialisation enrichment ───────────────────────────────
  it("attaches edition_type + is_serialised from the pinnacle_editions lookup", async () => {
    rpcState.get_wallet_moments_with_fmv = {
      data: [
        { moment_id: "m1", edition_key: "k-lim" },   // serialised type -> true
        { moment_id: "m2", edition_key: "k-open" },  // known unserialised -> false
        { moment_id: "m3", edition_key: "k-new" },   // unknown type in table -> null
        { moment_id: "m4" },                          // no edition_key -> null
      ],
      error: null,
    }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 0, moment_count: 4 }, error: null }
    tableState.pinnacle_editions = {
      data: [
        { edition_key: "k-lim", edition_type: "Limited Edition" },
        { edition_key: "k-open", edition_type: "Open Edition" },
        { edition_key: "k-new", edition_type: "Some Brand New Type" },
      ],
      error: null,
    }
    const body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    const byId = Object.fromEntries(body.moments.map((m: any) => [m.moment_id, m]))
    expect(byId.m1).toMatchObject({ edition_type: "Limited Edition", is_serialised: true })
    expect(byId.m2).toMatchObject({ edition_type: "Open Edition", is_serialised: false })
    expect(byId.m3).toMatchObject({ edition_type: "Some Brand New Type", is_serialised: null })
    expect(byId.m4).toMatchObject({ edition_type: null, is_serialised: null })
  })

  it("soft-fails the edition-type lookup and falls back to null edition_type", async () => {
    rpcState.get_wallet_moments_with_fmv = {
      data: [{ moment_id: "m1", edition_key: "k1" }],
      error: null,
    }
    rpcState.get_pinnacle_wallet_total_fmv = { data: { total_fmv: 0, moment_count: 1 }, error: null }
    // lookup errors -> empty map -> edition_type null, still 200.
    tableState.pinnacle_editions = { data: null, error: { message: "lookup down" } }
    const res = await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.moments[0].edition_type).toBeNull()
    expect(body.moments[0].is_serialised).toBeNull()
  })

  it("surfaces per-RPC error messages in the errors envelope (ADDITIVE legs)", async () => {
    // ⚠ REWRITTEN 2026-09-04, and the reason is the point. This case used to
    // fail the MOMENTS leg and assert `ok: true` — i.e. it pinned the route
    // answering "this wallet holds nothing" out of a failed read, with the
    // truth available only to a client that thought to look in `errors`. Per
    // CLAUDE.md a test that pins the defect it was named to prevent gets
    // INVERTED, not deleted: the envelope it checks is genuinely useful for the
    // ADDITIVE legs, which degrade to `null` and make no claim, so the case
    // keeps its job and moves to those. The moments leg gets its own case below.
    rpcState.get_pinnacle_wallet_total_fmv = { data: null, error: { message: "total failed" } }
    rpcState.get_pinnacle_variant_breakdown = { data: null, error: { message: "variants failed" } }
    const body = await (await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))).json()
    expect(body.ok).toBe(true)
    expect(body.errors.total).toBe("total failed")
    expect(body.errors.variants).toBe("variants failed")
    // The additive legs make no claim when they fail: null, never a zero.
    expect(body.totalFmv).toBeNull()
  })

  it("a failed MOMENTS read is not an empty wallet", async () => {
    // `moments` IS the page. `ok: true` with `moments: []` tells a collector
    // this wallet holds nothing — a false claim about their own holdings, out
    // of a read that failed. Before 2026-09-04 only a THROWN error reached the
    // catch; a RETURNED one rendered the empty wallet, and bounding these reads
    // turns an overrun into exactly that returned error.
    rpcState.get_wallet_moments_with_fmv = { data: [], error: { message: "moments failed" } }
    const res = await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.ok).not.toBe(true)
    expect(body.moments).toBeUndefined()
    // Anon-reachable route: the driver's own text must not be published.
    expect(JSON.stringify(body)).not.toContain("moments failed")
    expect(body.code).toBeTruthy()
  })

  it("500s when a data-fetch rejects (top-level catch)", async () => {
    control.throwRpc = "get_wallet_moments_with_fmv"
    const res = await GET(req("https://t/api/pinnacle-wallet?wallet=0xABC"))
    expect(res.status).toBe(500)
    // The driver message must not be published — this route is anon-reachable,
    // so this used to answer a visitor with the database's own text. It is
    // LOGGED server-side instead, and the body carries a classified code.
    const safeBody = await res.json()
    expect(safeBody.error).not.toContain("promise-all boom")
    expect(safeBody.code).toBeTruthy()
  })
})
