import { describe, it, expect } from "vitest"
import { pullValueView } from "@/lib/pack-pull-floor"

// lib/pack-pull-floor.ts — what a ripped pack's pull value may claim (review of
// a2ae9b801, 2026-09-25). A partial sum is a FLOOR: it may state a gain, never
// a loss. The case that motivated it: a $50 pack, 1 of 4 pulls priced at $2,
// published "PULLED $2 · −$48 vs cost · ROI −96%".

describe("pullValueView", () => {
  it("withholds a NEGATIVE delta and ROI when only some pulls are priced", () => {
    const v = pullValueView({ gross_pull_value_usd: 2, pull_count: 4, pulls_with_fmv: 1, total_cost_basis: 50 })
    expect(v.grossUsd).toBe(2)
    expect(v.partial).toBe(true)
    expect(v.deltaUsd).toBeNull()
    expect(v.roiPct).toBeNull()
  })

  it("keeps a POSITIVE delta off a floor — a floor above cost is a certain gain", () => {
    const v = pullValueView({ gross_pull_value_usd: "80", pull_count: 4, pulls_with_fmv: 3, total_cost_basis: 50 })
    expect(v.partial).toBe(true)
    expect(v.deltaUsd).toBe(30)
    expect(v.roiPct).toBe(60)
  })

  it("states a real loss when EVERY pull is priced", () => {
    const v = pullValueView({ gross_pull_value_usd: 20, pull_count: 4, pulls_with_fmv: 4, total_cost_basis: 50 })
    expect(v.partial).toBe(false)
    expect(v.deltaUsd).toBe(-30)
    expect(v.roiPct).toBe(-60)
  })

  it("no priced pull → no value at all, never $0", () => {
    const v = pullValueView({ gross_pull_value_usd: 0, pull_count: 4, pulls_with_fmv: 0, total_cost_basis: 50 })
    expect(v.grossUsd).toBeNull()
    expect(v.deltaUsd).toBeNull()
    expect(v.roiPct).toBeNull()
  })

  it("unknown counts are not 'partial' — the old behaviour, no invented caveat", () => {
    const v = pullValueView({ gross_pull_value_usd: 20, total_cost_basis: 50 })
    expect(v.partial).toBe(false)
    expect(v.deltaUsd).toBe(-30)
  })
})

// Wiring: the helper only protects the surfaces that call it. Both publishers
// of a pack's pull value must derive delta/ROI through it, not from the raw sum.
import { readFileSync } from "node:fs"
import path from "node:path"

describe("pack pull-value publishers route through pullValueView", () => {
  const ROOT = path.resolve(__dirname, "..")
  for (const rel of ["app/(collections)/[collection]/pack/[id]/page.tsx", "app/api/og/pack/lifecycle/route.tsx"]) {
    it(rel, () => {
      const src = readFileSync(path.join(ROOT, rel), "utf8")
      expect(src).toMatch(/pullValueView\(/)
    })
  }
})
