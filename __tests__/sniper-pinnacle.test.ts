// Unit tests for lib/sniper/pinnacle.ts — computePinnacleSniperFeed.
//
// ⚠ REWRITTEN 2026-09-27 with its source. The feed used to be built from
// Flowty's API (marketplace shut 2026-05-13; measured 2026-09-27: 96 NFTs,
// newest listing 2026-08-21, 2 deals). It now reads `pinnacle_live_listings`
// — every listing Disney's Studio GraphQL returned on the catalog sweep's last
// complete pass — via `get_pinnacle_live_listings_for_sniper`, already joined
// to each pin's render. The Flowty-era cases (FMV-map paging, NFT dedup, the
// legacy-key → render lookup) tested code that no longer exists; the
// properties they held are re-asserted against the new source below:
//   - a failed read is a FAILURE, never an empty board (now also: a STALE set)
//   - each listing is priced by ITS OWN render and links/illustrates that render
//   - the filters, sorts, 200-row cap and SniperDeal remap are unchanged
//
// @/lib/supabase is mocked: `.rpc()` returns state.rows; `.from(...)` returns
// the newest-seen_at probe (state.newest).

import { describe, it, expect, beforeEach, vi } from "vitest"

const NOW = Date.parse("2026-09-27T18:00:00.000Z")
const FRESH = "2026-09-27T13:45:17.000Z" // 4.25 h before NOW

const state: {
  rows: any[]
  rpcError: any
  newest: { data: any; error: any; count: number | null }
  rpcArgs: any
  mults: any
} = { rows: [], rpcError: null, newest: { data: [{ seen_at: FRESH }], error: null, count: 16000 }, rpcArgs: null, mults: null }

const MULTS = [
  { band: "first", multiplier: 14.45, is_reliable: true },
  { band: "perfect", multiplier: 3.49, is_reliable: true },
  { band: "normal", multiplier: 1, is_reliable: true },
]

vi.mock("@/lib/supabase", () => {
  const probe = (table: string) => {
    const b: any = {}
    for (const m of ["select", "order", "limit", "eq"]) b[m] = () => b
    b.then = (resolve: any) =>
      resolve(table === "pinnacle_serial_fmv_multipliers" ? { data: state.mults, error: null } : state.newest)
    return b
  }
  const client: any = {
    from: (table: string) => probe(table),
    rpc: async (_name: string, args: any) => {
      state.rpcArgs = args
      return { data: state.rpcError ? null : state.rows, error: state.rpcError }
    },
  }
  return { supabase: client, supabaseAdmin: client }
})

import { computePinnacleSniperFeed, matchesPinnacleStudioTab, PINNACLE_LIVE_LISTINGS_MAX_AGE_HOURS } from "@/lib/sniper/pinnacle"

// One row as get_pinnacle_live_listings_for_sniper returns it.
function row(o: Partial<Record<string, any>> = {}) {
  return {
    nft_id: o.nft_id ?? "n1",
    render_id: o.render_id ?? "OEV2-MNF-MIDO-E3",
    serial_number: o.serial_number ?? null,
    price_usd: o.price_usd ?? 50,
    seen_at: o.seen_at ?? FRESH,
    character_name: o.character_name ?? "Grogu",
    set_name: o.set_name ?? "Lucasfilm Ltd. • Mandalorian Vol.1",
    series_name: o.series_name ?? "2024",
    variant: o.variant ?? "Standard",
    total_minted: o.total_minted ?? 100,
    edition_type: o.edition_type ?? "Open Edition",
    is_chaser: o.is_chaser ?? false,
    legacy_edition_key: o.legacy_edition_key ?? "LUC-MAN:Standard:1",
    franchises: o.franchises ?? ["Star Wars"],
    fmv_usd: o.fmv_usd ?? 80,
    fmv_confidence: o.fmv_confidence ?? "HIGH",
    fmv_days_since_sale: o.fmv_days_since_sale ?? 2,
    fmv_sales_count_30d: o.fmv_sales_count_30d ?? 5,
  }
}

beforeEach(() => {
  state.rows = []
  state.rpcError = null
  state.newest = { data: [{ seen_at: FRESH }], error: null, count: 16000 }
  state.rpcArgs = null
  state.mults = MULTS
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  return () => vi.useRealTimers()
})

describe("computePinnacleSniperFeed — the live-listing source", () => {
  it("a fresh, genuinely empty set is an empty board (not an error)", async () => {
    const res = await computePinnacleSniperFeed()
    expect(res.count).toBe(0)
    expect(res.deals).toEqual([])
    expect(res.lastRefreshed).toBe(FRESH)
    expect(res.flowtyCount).toBe(16000) // live listings in the last complete sweep
  })

  it("a FAILED listings read throws — never an empty 'no deals' board", async () => {
    state.rpcError = { message: "db down" }
    await expect(computePinnacleSniperFeed()).rejects.toThrow(/failed/)
  })

  it("a failed freshness probe throws too", async () => {
    state.newest = { data: null, error: { message: "timeout" }, count: null }
    await expect(computePinnacleSniperFeed()).rejects.toThrow(/read failed/)
  })

  it("a set the sweep NEVER wrote throws", async () => {
    state.newest = { data: [], error: null, count: 0 }
    await expect(computePinnacleSniperFeed()).rejects.toThrow(/empty/)
  })

  it(`a set older than ${PINNACLE_LIVE_LISTINGS_MAX_AGE_HOURS} h throws — old asks are not published as live`, async () => {
    state.newest = { data: [{ seen_at: "2026-09-27T04:00:00.000Z" }], error: null, count: 16000 } // 14 h
    state.rows = [row()]
    await expect(computePinnacleSniperFeed()).rejects.toThrow(/h old/)
  })

  it("CONTROL: just inside the window still publishes", async () => {
    state.newest = { data: [{ seen_at: "2026-09-27T05:30:00.000Z" }], error: null, count: 16000 } // 12.5 h
    state.rows = [row()]
    expect((await computePinnacleSniperFeed()).count).toBe(1)
  })

  it("asks the RPC for a bounded read", async () => {
    await computePinnacleSniperFeed()
    expect(state.rpcArgs.p_limit).toBeGreaterThan(0)
    expect(state.rpcArgs.p_limit).toBeLessThanOrEqual(5000)
  })
})

describe("computePinnacleSniperFeed — each listing priced and linked as its own render", () => {
  it("prices against the row's own FMV and keeps only >= 5% discounts", async () => {
    state.rows = [
      row({ nft_id: "deal", price_usd: 50, fmv_usd: 80 }), // 37.5%
      row({ nft_id: "thin", price_usd: 78, fmv_usd: 80 }), // 2.5% — dropped
    ]
    const res = await computePinnacleSniperFeed()
    expect(res.deals.map((d) => d.momentId)).toEqual(["deal"])
    expect(res.deals[0]).toMatchObject({ discount: 37.5, askPrice: 50, adjustedFmv: 80 })
  })

  it("carries the render: its page key, its art, the pin name", async () => {
    state.rows = [row({ render_id: "OEV1-PPTB-SWIM-S2", character_name: "Just Keep Swimming" })]
    const d = (await computePinnacleSniperFeed()).deals[0]
    expect(d.renderId).toBe("OEV1-PPTB-SWIM-S2")
    expect(d.thumbnailUrl).toContain("OEV1-PPTB-SWIM-S2")
    expect(d.playerName).toBe("Just Keep Swimming")
  })

  // ⚠ 2026-09-27: the premium is the shared pattern — #1 and PERFECT only, from
  // pinnacle_serial_fmv_multipliers, over a HIGH/MEDIUM base (was 1 + 0.08×… on EVERY serial).
  it("a #1 serial is priced with the #1 premium, flagged, and carries the shared badge shape", async () => {
    state.rows = [row({ edition_type: "Limited Edition", serial_number: 1, total_minted: 100, price_usd: 50, fmv_usd: 80 })]
    const d = (await computePinnacleSniperFeed()).deals[0]
    expect(d.serialMult).toBe(14.45)
    expect(d.adjustedFmv).toBe(1156)
    expect(d).toMatchObject({ isSpecialSerial: true, serialSignal: "#1 Serial" })
    expect(d.serialFmvEstimate).toMatchObject({ serial_bucket: "first", estimate_usd: 1156 })
  })

  it("a PERFECT serial (#N of N) gets the perfect premium", async () => {
    state.rows = [row({ edition_type: "Limited Edition", serial_number: 100, total_minted: 100, price_usd: 50, fmv_usd: 80 })]
    const d = (await computePinnacleSniperFeed()).deals[0]
    expect(d.serialMult).toBe(3.49)
    expect(d).toMatchObject({ isSpecialSerial: true, serialSignal: "Perfect Serial" })
    expect(d.serialFmvEstimate).toMatchObject({ serial_bucket: "perfect" })
  })

  it("a LOW serial earns no premium any more", async () => {
    state.rows = [row({ edition_type: "Limited Edition", serial_number: 2, total_minted: 100, price_usd: 50, fmv_usd: 80 })]
    const d = (await computePinnacleSniperFeed()).deals[0]
    expect(d.serialMult).toBe(1)
    expect(d.adjustedFmv).toBe(80)
    expect(d.isSpecialSerial).toBe(false)
    expect(d.serialFmvEstimate).toBeUndefined()
  })

  it("no premium over a LOW-confidence base (the shared gate)", async () => {
    state.rows = [row({ edition_type: "Limited Edition", serial_number: 1, total_minted: 100, price_usd: 50, fmv_usd: 80, fmv_confidence: "LOW" })]
    const d = (await computePinnacleSniperFeed()).deals[0]
    expect(d.serialMult).toBe(1)
  })

  it("a failed model read prices at base FMV rather than failing the board", async () => {
    state.mults = null
    state.rows = [row({ edition_type: "Limited Edition", serial_number: 1, total_minted: 100, price_usd: 50, fmv_usd: 80 })]
    const res = await computePinnacleSniperFeed()
    expect(res.count).toBe(1)
    expect(res.deals[0].serialMult).toBe(1)
  })

  // The SAME display-time guards as every other collection (lib/sniper/fmv-staleness).
  it("applies the shared staleness haircut: one sale, weeks old → FMV x0.7", async () => {
    state.rows = [row({ price_usd: 20, fmv_usd: 100, fmv_confidence: "MEDIUM", fmv_days_since_sale: 20, fmv_sales_count_30d: 1 })]
    const d = (await computePinnacleSniperFeed()).deals[0]
    expect(d.adjustedFmv).toBeCloseTo(70)
    expect(d.discount).toBeCloseTo(71.4, 1)
  })
  it("a weak confidence priced from stale sales is capped at the ask — no fake 'deal'", async () => {
    state.rows = [row({ price_usd: 20, fmv_usd: 100, fmv_confidence: "LOW", fmv_days_since_sale: 45, fmv_sales_count_30d: 0 })]
    expect((await computePinnacleSniperFeed()).count).toBe(0)
  })
  it("an ASK_ONLY / STALE FMV carries the shared 'discount is uncertain' caveat", async () => {
    state.rows = [row({ nft_id: "a", fmv_confidence: "ASK_ONLY" }), row({ nft_id: "b", fmv_confidence: "HIGH" })]
    const byId = Object.fromEntries((await computePinnacleSniperFeed()).deals.map((d: any) => [d.momentId, d]))
    expect(byId.a.lowConfidenceFmv).toBe(true)
    expect(byId.b.lowConfidenceFmv).toBe(false)
  })

  it("an unserialised edition gets no multiplier even with a serial-like value", async () => {
    state.rows = [row({ edition_type: "Open Edition", serial_number: 1, total_minted: 100 })]
    const d = (await computePinnacleSniperFeed()).deals[0]
    expect(d.serialMult).toBe(1)
  })

  it("derives the studio from the '<Studio> • <Set>' set name", async () => {
    state.rows = [row({ nft_id: "pix", set_name: "Pixar Animation Studios • Toy Story Vol.4" })]
    const d = (await computePinnacleSniperFeed()).deals[0]
    expect(d.studio).toBe("Pixar Animation Studios")
  })
})

describe("computePinnacleSniperFeed — filters, sorts and the SniperDeal remap (unchanged)", () => {
  it("filters by variant (tier alias), case-insensitively", async () => {
    state.rows = [row({ nft_id: "std", variant: "Standard" }), row({ nft_id: "gold", variant: "Golden" })]
    const res = await computePinnacleSniperFeed({ variantFilter: "golden" })
    expect(res.deals.map((d) => d.momentId)).toEqual(["gold"])
  })

  it("filters by maxPrice and minDiscount", async () => {
    state.rows = [row({ nft_id: "cheap", price_usd: 20, fmv_usd: 80 }), row({ nft_id: "pricey", price_usd: 70, fmv_usd: 80 })]
    expect((await computePinnacleSniperFeed({ maxPrice: 50 })).deals.map((d) => d.momentId)).toEqual(["cheap"])
    expect((await computePinnacleSniperFeed({ minDiscount: 50 })).deals.map((d) => d.momentId)).toEqual(["cheap"])
  })

  it("filters by player across character/franchise/set", async () => {
    state.rows = [
      row({ nft_id: "grogu", character_name: "Grogu", franchises: ["Star Wars"] }),
      row({ nft_id: "mickey", character_name: "Mickey", franchises: ["Mickey & Friends"], set_name: "Walt Disney Animation Studios • Classic" }),
    ]
    expect((await computePinnacleSniperFeed({ playerFilter: "star wars" })).deals.map((d) => d.momentId)).toEqual(["grogu"])
  })

  it("sorts by discount desc by default, and supports the other sorts", async () => {
    state.rows = [row({ nft_id: "a", price_usd: 60, fmv_usd: 80 }), row({ nft_id: "b", price_usd: 20, fmv_usd: 200 })]
    expect((await computePinnacleSniperFeed()).deals.map((d) => d.momentId)).toEqual(["b", "a"])
    expect((await computePinnacleSniperFeed({ sortBy: "price_asc" })).deals.map((d) => d.momentId)).toEqual(["b", "a"])
    expect((await computePinnacleSniperFeed({ sortBy: "price_desc" })).deals.map((d) => d.momentId)).toEqual(["a", "b"])
    expect((await computePinnacleSniperFeed({ sortBy: "fmv_desc" })).deals.map((d) => d.momentId)).toEqual(["b", "a"])
  })

  it("caps the output at 200 deals", async () => {
    state.rows = Array.from({ length: 250 }, (_, i) => row({ nft_id: `d${i}`, price_usd: 10 + (i % 50) }))
    const res = await computePinnacleSniperFeed()
    expect(res.count).toBe(200)
  })

  it("remaps onto the unified SniperDeal shape", async () => {
    state.rows = [row({ nft_id: "n1", character_name: "Grogu", franchises: ["Star Wars"], variant: "Golden", series_name: "2024", total_minted: 100, fmv_confidence: "HIGH" })]
    const d = (await computePinnacleSniperFeed()).deals[0]
    expect(d).toMatchObject({
      momentId: "n1",
      flowId: "n1",
      playerName: "Grogu",
      teamName: "Star Wars",
      setName: "Lucasfilm Ltd. • Mandalorian Vol.1",
      seriesName: "2024",
      tier: "Golden",
      circulationCount: 100,
      confidence: "high",
      source: "pinnacle",
      paymentToken: "DUC",
      isLocked: false,
    })
  })
})

describe("computePinnacleSniperFeed — the studio and chasers-only filters", () => {
  const rows = () => [
    row({ nft_id: "wdas", set_name: "Walt Disney Animation Studios • Hercules Vol.1" }),
    row({ nft_id: "pix", set_name: "Pixar Animation Studios • Toy Story Vol.4", is_chaser: true }),
    row({ nft_id: "sw", set_name: "Lucasfilm Ltd. • Star Wars Helmets Vol.1" }),
    row({ nft_id: "fox", set_name: "20th Century Studios • Alien Vol.1" }),
  ]
  const ids = (r: any) => r.deals.map((d: any) => d.momentId).sort()

  it("each tab keeps only its studio", async () => {
    state.rows = rows()
    expect(ids(await computePinnacleSniperFeed({ franchiseFilter: "Pixar" }))).toEqual(["pix"])
    expect(ids(await computePinnacleSniperFeed({ franchiseFilter: "Star Wars" }))).toEqual(["sw"])
    expect(ids(await computePinnacleSniperFeed({ franchiseFilter: "Disney" }))).toEqual(["wdas"])
  })

  it("chasers-only keeps chasers, and the row says it is one", async () => {
    state.rows = rows()
    const res = await computePinnacleSniperFeed({ chaserOnly: true })
    expect(ids(res)).toEqual(["pix"])
    expect(res.deals[0]).toMatchObject({ isChaser: true })
  })

  it("NO-CHANGE CONTROL: 'all' and an unknown tab filter nothing", async () => {
    state.rows = rows()
    expect(ids(await computePinnacleSniperFeed({ franchiseFilter: "all" }))).toHaveLength(4)
    expect(ids(await computePinnacleSniperFeed({ franchiseFilter: "Marvel" }))).toHaveLength(4)
  })

  it("a joint Disney & Pixar set sits under both tabs", () => {
    const set = "Walt Disney & Pixar Animation Studios • Crossover Vol.1"
    expect(matchesPinnacleStudioTab("Disney", "Unknown", set)).toBe(true)
    expect(matchesPinnacleStudioTab("Pixar", "Unknown", set)).toBe(true)
    expect(matchesPinnacleStudioTab("Star Wars", "Unknown", set)).toBe(false)
  })
})
