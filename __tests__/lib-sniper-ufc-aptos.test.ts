// __tests__/lib-sniper-ufc-aptos.test.ts
//
// UFC Strike's sniper (2026-11-26): every live single-Moment Rarible ask on Aptos, priced in USD at
// the day's APT/USD rate, against RPC FMV, tagged Aptos. A failed read throws (the route degrades
// the board) — it is never an empty "no listings".

import { beforeEach, describe, expect, it, vi } from "vitest"

const db = {
  listings: [] as Array<Record<string, unknown>>,
  listingsError: null as unknown,
  apt: [{ day: "2026-11-26", usd: 0.5 }] as Array<Record<string, unknown>>,
  editions: [] as Array<Record<string, unknown>>,
  fmv: [] as Array<Record<string, unknown>>,
  fmvError: null as unknown,
}

function thenable(resolveWith: () => unknown) {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "gt", "gte", "not", "order", "limit", "in"]) b[m] = () => b
  b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(resolveWith()).then(ok, bad)
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (t: string) => {
      if (t === "ufc_aptos_listings") return thenable(() => (db.listingsError ? { data: null, error: db.listingsError } : { data: db.listings, error: null }))
      if (t === "apt_usd_daily") return thenable(() => ({ data: db.apt, error: null }))
      if (t === "editions") return thenable(() => ({ data: db.editions, error: null }))
      if (t === "edition_fmv_current") return thenable(() => (db.fmvError ? { data: null, error: db.fmvError } : { data: db.fmv, error: null }))
      throw new Error("unexpected table " + t)
    },
  },
}))

const { computeUfcAptosSniperFeed } = await import("@/lib/sniper/ufc-aptos")
const { sniperSubtitle, SNIPER_SUBTITLE_UFC_APTOS } = await import("@/lib/sniper/header-copy")
const { fmtDiscount } = await import("@/lib/sniper/helpers")

const L = (over: Record<string, unknown> = {}) => ({
  listing_address: "0xl1", token_data_id: "0xt1", aptos_collection_id: "0xabc", edition_id: "e1", serial_number: 17,
  marketplace: "rarible", price_apt: 20, seller: "0xs", listed_at: "2026-11-20T00:00:00Z", last_checked_at: "2026-11-26T16:00:00Z", ...over,
})

beforeEach(() => {
  db.listings = [L()]
  db.listingsError = null
  db.apt = [{ day: "2026-11-26", usd: 0.5 }]
  db.editions = [{ id: "e1", external_id: "733", player_name: "Geoff Neal", team_name: null, set_name: "FN", tier: "CHALLENGER", circulation_count: 1000, thumbnail_url: null }]
  db.fmv = [{ edition_id: "e1", fmv_usd: 8, confidence: "STALE" }]
  db.fmvError = null
})

describe("computeUfcAptosSniperFeed", () => {
  it("prices the APT ask in USD, signs the discount, tags Aptos and links Rarible", async () => {
    const r = await computeUfcAptosSniperFeed()
    expect(r.deals).toHaveLength(1)
    const d = r.deals[0]
    expect(d.askApt).toBe(20)
    expect(d.askPrice).toBe(10)
    expect(d.discount).toBe(-25) // ask $10 vs FMV $8: 25 % ABOVE FMV — signed, never clamped to 0
    expect(d.chain).toBe("aptos")
    expect(d.venue).toBe("Rarible")
    expect(d.buyUrl).toBe("https://rarible.com/collection/aptos/0xabc/items")
    expect(d.editionKey).toBe("733")
    expect(d.isLowestAsk).toBe(true)
  })

  it("an ask on an edition with no FMV is not valued at 0 — it is left off the board", async () => {
    db.fmv = []
    expect((await computeUfcAptosSniperFeed()).deals).toEqual([])
  })

  it("minDiscount keeps only asks at least that far below FMV", async () => {
    db.listings = [L(), L({ listing_address: "0xl2", token_data_id: "0xt2", price_apt: 8 })] // $4 vs $8 = 50 % below
    const r = await computeUfcAptosSniperFeed({ minDiscount: 10 })
    expect(r.deals.map((d) => d.flowId)).toEqual(["0xt2"])
  })

  it("a failed listing read throws — never an empty board", async () => {
    db.listingsError = { message: "timeout" }
    await expect(computeUfcAptosSniperFeed()).rejects.toThrow(/ufc_aptos_listings/)
  })

  it("a failed FMV read throws — never asks priced against nothing", async () => {
    db.fmvError = { message: "boom" }
    await expect(computeUfcAptosSniperFeed()).rejects.toThrow(/edition_fmv_current/)
  })

  it("no APT/USD rate throws — an APT ask is never shown as a USD price it is not", async () => {
    db.apt = []
    await expect(computeUfcAptosSniperFeed()).rejects.toThrow(/APT\/USD/)
  })

  it("a read at the 1,000-row cap is a partial book and throws", async () => {
    db.listings = Array.from({ length: 1000 }, (_, i) => L({ listing_address: "0x" + i }))
    await expect(computeUfcAptosSniperFeed()).rejects.toThrow(/cap/)
  })
})

describe("UFC sniper copy", () => {
  it("the header says asks, not deals below FMV", () => {
    expect(sniperSubtitle("ufc", false)).toBe(SNIPER_SUBTITLE_UFC_APTOS)
    expect(sniperSubtitle("ufc-strike", false)).toBe(SNIPER_SUBTITLE_UFC_APTOS)
    expect(SNIPER_SUBTITLE_UFC_APTOS).not.toMatch(/BELOW/)
  })

  it("an ask above FMV reads +%, never '~0%'", () => {
    expect(fmtDiscount(-25)).toBe("+25.0%")
    expect(fmtDiscount(12)).toBe("-12.0%")
    expect(fmtDiscount(-0.2)).toBe("~0%")
  })
})

describe("the board's client filter keeps asks-board rows", () => {
  it("an Aptos ask above FMV on a STALE FMV survives the below-FMV, verified-only and after-fees gates; a deal row does not", async () => {
    const { filterSniperDeals } = await import("@/lib/sniper/helpers")
    const base = { discount: -25, confidence: "stale", playerName: "P", setName: "S", teamName: "", netOfFees: { feePct: 5, netIfResold: 7.6, netMarginUsd: -2.4, netMarginPct: -24, flipsNegative: true } }
    const out = filterSniperDeals([
      { ...base, flowId: "a", source: "ufc_aptos" },
      { ...base, flowId: "b", source: "topshot" },
    ] as never, { showVerifiedOnly: true, afterFeesOnly: true })
    expect(out.map((d) => d.flowId)).toEqual(["a"])
  })
})
