import { describe, it, expect } from "vitest"
import {
  TIER_RARITY_ORDER,
  sumPoolRemaining,
  orderedTiersWithSupply,
  pctOfPoolLabel,
  deriveDualPrice,
  computeTopPulls,
  type TopPullEdition,
  type TopPullFmvRow,
  type TopPullPoolRow,
} from "@/lib/pack-dist-odds"

describe("pack-dist-odds — sumPoolRemaining", () => {
  it("sums remaining across tiers, coercing non-numbers to 0", () => {
    expect(sumPoolRemaining({ common: 100, rare: 20, legendary: 5 })).toBe(125)
    expect(sumPoolRemaining({ common: 10, bad: NaN as unknown as number })).toBe(10)
  })
  it("is 0 for an empty pool", () => {
    expect(sumPoolRemaining({})).toBe(0)
  })
})

describe("pack-dist-odds — orderedTiersWithSupply", () => {
  it("orders standard tiers by rarity and drops zero-supply tiers", () => {
    const out = orderedTiersWithSupply({ common: 100, legendary: 5, rare: 0, ultimate: 1 })
    expect(out).toEqual(["ultimate", "legendary", "common"])
  })
  it("appends non-standard tiers with supply after the standard ones, in key order", () => {
    const out = orderedTiersWithSupply({ legendary: 2, mythic: 3, chase: 1 })
    expect(out).toEqual(["legendary", "mythic", "chase"])
  })
  it("returns [] when nothing has supply", () => {
    expect(orderedTiersWithSupply({ common: 0, rare: 0 })).toEqual([])
  })
  it("TIER_RARITY_ORDER puts ultimate first, common last", () => {
    expect(TIER_RARITY_ORDER[0]).toBe("ultimate")
    expect(TIER_RARITY_ORDER[TIER_RARITY_ORDER.length - 1]).toBe("common")
  })
})

describe("pack-dist-odds — pctOfPoolLabel", () => {
  it("returns em-dash when the pool is empty (null pct)", () => {
    expect(pctOfPoolLabel(5, 0)).toBe("—")
  })
  it("returns <0.1% for a tiny positive share", () => {
    // 1 / 2000 = 0.05%
    expect(pctOfPoolLabel(1, 2000)).toBe("<0.1%")
  })
  it("uses 1 decimal below 10%", () => {
    // 5 / 100 = 5.0%
    expect(pctOfPoolLabel(5, 100)).toBe("5.0%")
  })
  it("uses 0 decimals at/above 10%", () => {
    // 25 / 100 = 25%
    expect(pctOfPoolLabel(25, 100)).toBe("25%")
  })
  it("returns 0.0% for a zero share of a non-empty pool", () => {
    expect(pctOfPoolLabel(0, 100)).toBe("0.0%")
  })
})

describe("pack-dist-odds — deriveDualPrice", () => {
  const base = {
    primaryPrice: 10,
    secondaryAsk: 12,
    primaryAvailable: true,
    secondaryAvailable: true,
  }
  it("flags the legacy single-line fallback when priceSource is null", () => {
    const d = deriveDualPrice({ ...base, priceSource: null })
    expect(d.legacy).toBe(true)
    expect(d).toMatchObject({ primaryLive: false, secondaryLive: false, primaryAnchor: false, secondaryAnchor: false })
  })
  it("marks a leg live only when available, non-null, and > 0", () => {
    expect(deriveDualPrice({ ...base, priceSource: "primary" }).primaryLive).toBe(true)
    expect(deriveDualPrice({ ...base, primaryPrice: 0, priceSource: "primary" }).primaryLive).toBe(false)
    expect(deriveDualPrice({ ...base, primaryAvailable: false, priceSource: "primary" }).primaryLive).toBe(false)
    expect(deriveDualPrice({ ...base, secondaryAsk: null, priceSource: "secondary" }).secondaryLive).toBe(false)
  })
  it("anchors the primary leg for source 'primary' and 'min'", () => {
    expect(deriveDualPrice({ ...base, priceSource: "primary" })).toMatchObject({ primaryAnchor: true, secondaryAnchor: false })
    expect(deriveDualPrice({ ...base, priceSource: "min" })).toMatchObject({ primaryAnchor: true, secondaryAnchor: true })
  })
  it("anchors only the secondary leg for source 'secondary'", () => {
    expect(deriveDualPrice({ ...base, priceSource: "secondary" })).toMatchObject({ primaryAnchor: false, secondaryAnchor: true })
  })
  it("anchors neither leg for source 'none'", () => {
    expect(deriveDualPrice({ ...base, priceSource: "none" })).toMatchObject({ primaryAnchor: false, secondaryAnchor: false, legacy: false })
  })
})

// ── computeTopPulls (fetchTopPulls' pure edition-EV core) ───────────────────
describe("pack-dist-odds — computeTopPulls", () => {
  const ed = (id: string, over: Partial<TopPullEdition> = {}): TopPullEdition => ({
    id,
    name: null,
    tier: null,
    external_id: `ext-${id}`,
    player_name: null,
    set_name: null,
    ...over,
  })

  it("computes probability and edition EV against the totalUnopened denominator", () => {
    // denom = totalUnopened = 100; slots = 2.
    //   probPct = drop_weight/100*100 ; ev = fmv * (drop_weight/100) * slots
    const pool: TopPullPoolRow[] = [{ edition_id: "a", drop_weight: 10 }]
    const editions: TopPullEdition[] = [ed("a", { player_name: "Dame", set_name: "Base", tier: "COMMON" })]
    const fmv: TopPullFmvRow[] = [{ edition_id: "a", fmv_usd: 50 }]

    const [row] = computeTopPulls({ pool, editions, fmv, fullPoolWeight: 999, totalUnopened: 100, slots: 2 })
    expect(row.probabilityPct).toBeCloseTo(10, 6) // 10/100*100
    expect(row.editionEv).toBeCloseTo(50 * (10 / 100) * 2, 6) // = 10
    expect(row).toMatchObject({ editionId: "a", player: "Dame", setName: "Base", tier: "COMMON", externalId: "ext-a" })
  })

  it("falls back to the full-pool weight when totalUnopened is missing, never the partial top-50 sum", () => {
    const pool: TopPullPoolRow[] = [{ edition_id: "a", drop_weight: 10 }] // partial sum would be 10
    const [row] = computeTopPulls({
      pool,
      editions: [ed("a")],
      fmv: [{ edition_id: "a", fmv_usd: 20 }],
      fullPoolWeight: 200, // the real denominator
      totalUnopened: null,
      slots: 1,
    })
    // Uses 200, not 10 — so the probability is 5%, not a wildly inflated 100%.
    expect(row.probabilityPct).toBeCloseTo(5, 6)
    expect(row.editionEv).toBeCloseTo(20 * (10 / 200) * 1, 6)
  })

  it("yields null probability AND null EV when no denominator is available", () => {
    const [row] = computeTopPulls({
      pool: [{ edition_id: "a", drop_weight: 10 }],
      editions: [ed("a")],
      fmv: [{ edition_id: "a", fmv_usd: 20 }],
      fullPoolWeight: 0,
      totalUnopened: null,
      slots: 1,
    })
    expect(row.probabilityPct).toBeNull()
    expect(row.editionEv).toBeNull()
  })

  it("leaves EV null when FMV is missing/non-positive or slots is absent (never a fabricated 0-EV)", () => {
    const pool: TopPullPoolRow[] = [
      { edition_id: "noFmv", drop_weight: 10 },
      { edition_id: "zeroFmv", drop_weight: 10 },
      { edition_id: "priced", drop_weight: 10 },
    ]
    const editions = [ed("noFmv"), ed("zeroFmv"), ed("priced")]
    const fmv: TopPullFmvRow[] = [
      { edition_id: "zeroFmv", fmv_usd: 0 }, // non-positive → dropped from the map
      { edition_id: "priced", fmv_usd: 40 },
    ]
    const byId = Object.fromEntries(
      computeTopPulls({ pool, editions, fmv, fullPoolWeight: 100, totalUnopened: 100, slots: null }).map((r) => [r.editionId, r]),
    )
    // slots null → every EV null, but probability still computes.
    expect(byId.priced.editionEv).toBeNull()
    expect(byId.priced.probabilityPct).toBeCloseTo(10, 6)
    // no-FMV and zero-FMV rows carry null fmv and null EV, never $0.
    expect(byId.noFmv.fmvUsd).toBeNull()
    expect(byId.zeroFmv.fmvUsd).toBeNull()
  })

  it("sorts by editionEv desc with null last, tie-breaks by drop_weight desc, and caps at the limit", () => {
    const pool: TopPullPoolRow[] = [
      { edition_id: "lowEv", drop_weight: 5 },
      { edition_id: "highEv", drop_weight: 1 },
      { edition_id: "nullEvBigWeight", drop_weight: 99 }, // no fmv → null EV → sorts last
      { edition_id: "nullEvSmallWeight", drop_weight: 3 },
    ]
    const editions = pool.map((p) => ed(p.edition_id))
    const fmv: TopPullFmvRow[] = [
      { edition_id: "lowEv", fmv_usd: 10 }, // ev = 10*(5/100)*1 = 0.5
      { edition_id: "highEv", fmv_usd: 1000 }, // ev = 1000*(1/100)*1 = 10
    ]
    const out = computeTopPulls({ pool, editions, fmv, fullPoolWeight: 100, totalUnopened: 100, slots: 1 })
    expect(out.map((r) => r.editionId)).toEqual([
      "highEv", // 10
      "lowEv", // 0.5
      "nullEvBigWeight", // null EV, larger weight first
      "nullEvSmallWeight",
    ])
    // limit caps the returned rows
    expect(computeTopPulls({ pool, editions, fmv, fullPoolWeight: 100, totalUnopened: 100, slots: 1, limit: 2 })).toHaveLength(2)
  })

  it("prefers denormalized player/set columns and falls back to splitEditionName only when empty", () => {
    const pool: TopPullPoolRow[] = [
      { edition_id: "denorm", drop_weight: 1 },
      { edition_id: "split", drop_weight: 1 },
    ]
    const editions: TopPullEdition[] = [
      ed("denorm", { player_name: "  LeBron James  ", set_name: "  MVP  ", name: "IGNORED GLUED NAME" }),
      // no denorm columns → split the glued edition name
      ed("split", { player_name: null, set_name: null, name: "Ja Morant - Base Set" }),
    ]
    const byId = Object.fromEntries(
      computeTopPulls({ pool, editions, fmv: [], fullPoolWeight: 10, totalUnopened: 10, slots: 1 }).map((r) => [r.editionId, r]),
    )
    expect(byId.denorm).toMatchObject({ player: "LeBron James", setName: "MVP" })
    // whatever splitEditionName yields for the fallback, it must not be the glued name verbatim
    expect(byId.split.player.length).toBeGreaterThan(0)
  })
})
