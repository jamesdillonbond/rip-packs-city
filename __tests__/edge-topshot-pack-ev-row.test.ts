import { describe, it, expect } from "vitest"
import {
  clampEv,
  derivePackEvRow,
  sentinelEvRow,
  type DualPriceLike,
} from "@/supabase/functions/_shared/topshot-pack-ev-row"

// The arithmetic behind the PUBLIC +EV badge, which lives in the largest file no coverage
// gate measures. Every assertion below is a claim the product makes to a collector who is
// deciding whether to spend money on a pack.

const priced = (packPrice: number): DualPriceLike => ({ packPrice, priceSource: "primary" })
const unpriced: DualPriceLike = { packPrice: 0, priceSource: "none" }

describe("derivePackEvRow — the +EV badge", () => {
  it("flags a pack whose gross EV beats its price", () => {
    const r = derivePackEvRow({
      grossEv: 150, typicalPullEv: 40, dual: priced(99), totalPackCount: 100, totalUnopened: 40,
    })
    expect(r.pack_ev).toBe(51)
    expect(r.is_positive_ev).toBe(true)
  })

  it("does NOT flag a pack whose gross EV is below its price", () => {
    const r = derivePackEvRow({
      grossEv: 50, typicalPullEv: 10, dual: priced(99), totalPackCount: 100, totalUnopened: 40,
    })
    expect(r.pack_ev).toBe(-49)
    expect(r.is_positive_ev).toBe(false)
  })

  // ⚠ THE RULE MOST WORTH PROTECTING. priceSource "none" means nothing is buyable — no
  // primary supply and no live secondary ask. The pack price is then 0, so pack_ev equals
  // the whole gross EV and the naive `packEv > 0` alone would mark EVERY unbuyable pack as
  // the best deal on the board. The badge would be at its loudest exactly where a collector
  // can do nothing with it.
  it("never flags a pack that cannot be bought, however large its gross EV", () => {
    const r = derivePackEvRow({
      grossEv: 5000, typicalPullEv: 900, dual: unpriced, totalPackCount: 100, totalUnopened: 0,
    })
    expect(r.pack_ev).toBe(5000)
    expect(r.is_positive_ev).toBe(false)
  })

  it("treats break-even as NOT positive — the badge needs a strict edge", () => {
    const r = derivePackEvRow({
      grossEv: 99, typicalPullEv: 20, dual: priced(99), totalPackCount: 10, totalUnopened: 5,
    })
    expect(r.pack_ev).toBe(0)
    expect(r.is_positive_ev).toBe(false)
  })

  it("rounds pack_ev to cents rather than publishing a float artefact", () => {
    const r = derivePackEvRow({
      grossEv: 10.005, typicalPullEv: null, dual: priced(0.001), totalPackCount: 0, totalUnopened: 0,
    })
    expect(r.pack_ev).toBe(10)
  })
})

describe("derivePackEvRow — value_ratio is withheld, never fabricated", () => {
  it("computes the ratio to three decimals when there is a price", () => {
    const r = derivePackEvRow({
      grossEv: 150, typicalPullEv: null, dual: priced(99), totalPackCount: 0, totalUnopened: 0,
    })
    expect(r.value_ratio).toBe(1.515)
  })

  // A ratio against a zero price is UNDEFINED, not enormous. This is the `|| 1` class the
  // profile page paid for with "↑ 50000.0% / 30D": guarding a divide-by-zero by substituting
  // a denominator publishes a number nobody measured.
  it("returns NULL rather than dividing by a zero price", () => {
    const r = derivePackEvRow({
      grossEv: 500, typicalPullEv: null, dual: unpriced, totalPackCount: 0, totalUnopened: 0,
    })
    expect(r.value_ratio).toBeNull()
    // and specifically not Infinity, NaN, or a substituted denominator
    expect(Number.isFinite(r.value_ratio as number)).toBe(false)
  })
})

describe("derivePackEvRow — typical_ev is optional and stays distinguishable from zero", () => {
  // "Typical Pull" is the median-pull EV the public board LEADS with, because the mean is
  // dragged upward by grails almost nobody pulls. When the RPC cannot produce one, the
  // field must stay NULL: a 0 would read as "the typical pull is worthless", which is a
  // much stronger claim than "we could not compute it".
  it("passes a null typical pull through as NULL, not 0", () => {
    const r = derivePackEvRow({
      grossEv: 86, typicalPullEv: null, dual: priced(10), totalPackCount: 0, totalUnopened: 0,
    })
    expect(r.typical_ev).toBeNull()
  })

  it("keeps a genuine zero as 0", () => {
    const r = derivePackEvRow({
      grossEv: 86, typicalPullEv: 0, dual: priced(10), totalPackCount: 0, totalUnopened: 0,
    })
    expect(r.typical_ev).toBe(0)
  })

  it("clamps typical_ev on the same range as the others", () => {
    const r = derivePackEvRow({
      grossEv: 1, typicalPullEv: 9_999_999, dual: priced(1), totalPackCount: 0, totalUnopened: 0,
    })
    expect(r.typical_ev).toBe(1_000_000)
  })
})

describe("clampEv — keeps a wrong pack VISIBLE instead of vanishing it", () => {
  // `pack_ev_latest` filters BETWEEN -10000 AND 1000000. An unclamped outlier does not
  // render as a silly number — the row falls out of the view and the pack disappears from
  // every EV surface, which looks like "we have no data" rather than "this reading is off".
  it("clamps above the view's ceiling", () => {
    expect(clampEv(50_000_000)).toBe(1_000_000)
  })

  it("clamps below the view's floor", () => {
    expect(clampEv(-999_999)).toBe(-10_000)
  })

  it("leaves an in-range value exactly alone, including the boundaries", () => {
    expect(clampEv(-10_000)).toBe(-10_000)
    expect(clampEv(1_000_000)).toBe(1_000_000)
    expect(clampEv(123.45)).toBe(123.45)
  })

  it("applies to gross_ev and pack_ev on the row, not just in isolation", () => {
    const r = derivePackEvRow({
      grossEv: 8_000_000, typicalPullEv: null, dual: priced(1), totalPackCount: 0, totalUnopened: 0,
    })
    expect(r.gross_ev).toBe(1_000_000)
    expect(r.pack_ev).toBe(1_000_000)
    // ⚠ but is_positive_ev is decided on the UNCLAMPED arithmetic, so clamping can never
    // change the badge — only what is displayed beside it.
    expect(r.is_positive_ev).toBe(true)
  })
})

describe("derivePackEvRow — depletion_pct", () => {
  it("reports the share of the print run already opened", () => {
    const r = derivePackEvRow({
      grossEv: 1, typicalPullEv: null, dual: priced(1), totalPackCount: 1000, totalUnopened: 250,
    })
    expect(r.depletion_pct).toBe(75)
  })

  // An unknown print run is NULL, not 0. A 0 would say "none of this pack has been opened",
  // which is a factual claim about supply, and it is the reading that most flatters a pack.
  it("returns NULL when the print run size is unknown", () => {
    const r = derivePackEvRow({
      grossEv: 1, typicalPullEv: null, dual: priced(1), totalPackCount: 0, totalUnopened: 0,
    })
    expect(r.depletion_pct).toBeNull()
  })

  it("clamps to 0..100 so bad supply data cannot publish an impossible percentage", () => {
    // more unopened than were ever printed -> would be negative
    expect(
      derivePackEvRow({
        grossEv: 1, typicalPullEv: null, dual: priced(1), totalPackCount: 100, totalUnopened: 140,
      }).depletion_pct,
    ).toBe(0)
    // negative unopened -> would exceed 100
    expect(
      derivePackEvRow({
        grossEv: 1, typicalPullEv: null, dual: priced(1), totalPackCount: 100, totalUnopened: -40,
      }).depletion_pct,
    ).toBe(100)
  })

  it("reports 100 for a fully-opened print run", () => {
    const r = derivePackEvRow({
      grossEv: 1, typicalPullEv: null, dual: priced(1), totalPackCount: 500, totalUnopened: 0,
    })
    expect(r.depletion_pct).toBe(100)
  })
})

describe("sentinelEvRow — an unpriceable pack must not read as a measured zero", () => {
  it("is unambiguously not-positive with a withheld ratio", () => {
    const s = sentinelEvRow()
    expect(s.is_positive_ev).toBe(false)
    expect(s.value_ratio).toBeNull()
    expect(s.fmv_coverage_pct).toBeNull()
  })

  // The sentinel's zeros are a placeholder, and the NULL value_ratio is what separates it
  // from a pack we genuinely priced at break-even. If value_ratio were 0 instead, the two
  // would be identical in the row and on every surface that reads it.
  it("differs from a genuinely break-even priced pack precisely in value_ratio", () => {
    const s = sentinelEvRow()
    const breakEven = derivePackEvRow({
      grossEv: 10, typicalPullEv: null, dual: priced(10), totalPackCount: 0, totalUnopened: 0,
    })
    expect(breakEven.pack_ev).toBe(s.pack_ev)
    expect(breakEven.is_positive_ev).toBe(s.is_positive_ev)
    expect(breakEven.value_ratio).not.toBeNull()
    expect(s.value_ratio).toBeNull()
  })

  it("claims full depletion, which is a real statement about an empty pool", () => {
    expect(sentinelEvRow().depletion_pct).toBe(100)
    expect(sentinelEvRow().edition_count).toBe(0)
  })
})
