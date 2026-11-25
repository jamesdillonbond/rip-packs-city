import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pinInsightChips, type PinChipInput } from "@/lib/pinnacle/pin-insight-chips"
import { readPinChipFacts } from "@/lib/pinnacle/pin-insight-reads"

// 2026-11-23 (Pinnacle parity pass 4): "Featured in Insights" chips on Pinnacle pin pages. A chip is a claim, so it
// appears only when its fact is TRUE of this pin and was READ — a failed read (null) earns no chip, never a guess.

const none: PinChipInput = { scarcityPct: null, listed: null, collectorHeld: null, sweepers: null, specialSerial: null, packPulls: null }

describe("pinInsightChips", () => {
  it("earns nothing from unknowns", () => {
    expect(pinInsightChips(none)).toEqual([])
  })
  it("scarcity only when scarcer than the family", () => {
    expect(pinInsightChips({ ...none, scarcityPct: 42.4 })[0]).toMatchObject({ key: "scarcity", label: "42% scarcer than its variant family →" })
    expect(pinInsightChips({ ...none, scarcityPct: -10 })).toEqual([])
  })
  it("squeeze only with a known supply of ≥ 25 and ≤ 2 % listed; 0 listed says 'None'", () => {
    expect(pinInsightChips({ ...none, listed: 0, collectorHeld: 29 })[0].label).toBe("None of 29 collector-held copies listed →")
    expect(pinInsightChips({ ...none, listed: 2, collectorHeld: 200 })[0].label).toBe("Only 2 of 200 collector-held copies listed →")
    expect(pinInsightChips({ ...none, listed: 5, collectorHeld: 200 })).toEqual([]) // 2.5 %
    expect(pinInsightChips({ ...none, listed: 0, collectorHeld: 10 })).toEqual([]) // too few held
    expect(pinInsightChips({ ...none, listed: null, collectorHeld: 100 })).toEqual([]) // listings read failed
    expect(pinInsightChips({ ...none, listed: 0, collectorHeld: null })).toEqual([]) // supply unknown
  })
  it("hot floors, serial and pack reality", () => {
    const c = pinInsightChips({
      ...none,
      sweepers: 1,
      specialSerial: { serial: 10, perfect: true, priceUsd: 925 },
      packPulls: [
        { dist_id: "8000", title: "Old Pack", first_opened_at: "2025-03-01T00:00:00Z" },
        { dist_id: "8912", title: "Stitch in Costume Vol.1", first_opened_at: "2026-11-06T22:00:35Z" },
      ],
    })
    expect(c.map((x) => x.label)).toEqual([
      "Bought in bulk by 1 collector this week →",
      "Perfect serial #10 sold for $925 →",
      "Pulled from Stitch in Costume Vol.1 — did the pack pay? →",
    ])
    expect(pinInsightChips({ ...none, packPulls: [{ dist_id: "8000", title: "Old", first_opened_at: "2025-03-01T00:00:00Z" }] })).toEqual([])
    // 2026-11-24: drops the Pack Reality board excludes never earn the chip; a later board drop on the same pin still does.
    const t = "2026-10-01T00:00:00Z"
    for (const p of [{ dist_id: "8906", title: "Internal Test" }, { dist_id: "8001", title: "[OLD] Something" }, { dist_id: "8002", title: "Distribution Mock Test" }, { dist_id: "8922", title: "Walt Disney Mugs Vol.1" }]) {
      expect(pinInsightChips({ ...none, packPulls: [{ ...p, first_opened_at: t }] })).toEqual([])
    }
    expect(pinInsightChips({ ...none, packPulls: [{ dist_id: "8922", title: "Mugs", first_opened_at: t }, { dist_id: "8923", title: "Mugs Standard", first_opened_at: t }] }).map((c) => c.label))
      .toEqual(["Pulled from Mugs Standard — did the pack pay? →"])
    expect(pinInsightChips({ ...none, specialSerial: { serial: 1, perfect: false, priceUsd: 45 } })[0].label).toBe("#1 sold for $45.00 →")
  })
})

describe("readPinChipFacts", () => {
  function db(opts: { cap?: unknown; capErr?: boolean; hot?: unknown; serial?: unknown }) {
    const builder = (table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ["select", "eq", "in", "gt", "order", "limit"]) b[m] = () => b
      b.then = (f: (v: unknown) => unknown) =>
        Promise.resolve(
          table === "market_cap_current"
            ? (opts.capErr ? { data: null, error: { message: "x" } } : { data: opts.cap ?? [], error: null })
            : { data: opts.serial ?? [], error: null },
        ).then(f)
      return b
    }
    return { from: builder, rpc: async () => ({ data: opts.hot ?? { editions: [] }, error: null }) }
  }
  it("reads supply, sweepers and the latest special serial", async () => {
    const f = await readPinChipFacts("R1", 10, db({
      cap: [{ collector_held: 29 }],
      hot: { editions: [{ external_id: "R1", sweep_buyers: 3 }, { external_id: "R2", sweep_buyers: 9 }] },
      serial: [{ serial_number: 10, sale_price_usd: 925 }],
    }))
    expect(f).toEqual({ collectorHeld: 29, sweepers: 3, specialSerial: { serial: 10, perfect: true, priceUsd: 925 } })
  })
  it("a failed read is null, never 0", async () => {
    const f = await readPinChipFacts("R1", 10, db({ capErr: true }))
    expect(f.collectorHeld).toBeNull()
    expect(f.sweepers).toBeNull()
    expect(f.specialSerial).toBeNull()
  })
})

describe("wiring", () => {
  it("the pin page streams the chips", () => {
    const src = readFileSync(join(process.cwd(), "app/pinnacle/moment/[id]/page.tsx"), "utf8")
    expect(src).toMatch(/<Suspense fallback=\{null\}>\s*<PinInsightChips/)
  })
})
