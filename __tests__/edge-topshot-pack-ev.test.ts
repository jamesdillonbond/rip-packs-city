import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  survivorPoolWeight,
  mergeRemainingByEdition,
  clampTopshotEv,
  shapeTopshotEvRow,
} from "@/supabase/functions/_shared/topshot-pack-ev"

// Pins the TOP SHOT pack-EV writer's inline math — the one pack-EV writer whose
// post-RPC shaping never got extracted, and the collection the P0 fabricated-EV
// incident lived on. Two layers: unit tests on the extracted pure logic, and a
// source-drift guard so the deployed edge fn's inline copies can't silently
// diverge from what these tests pin.

describe("survivorPoolWeight — remaining share of unopened supply", () => {
  it("is remaining / totalUnopened", () => {
    expect(survivorPoolWeight(30, 120)).toBe(0.25)
  })
  it("is 0 (never NaN/Infinity) when total unopened is 0", () => {
    expect(survivorPoolWeight(5, 0)).toBe(0)
    expect(Number.isFinite(survivorPoolWeight(5, 0))).toBe(true)
  })
  it("a fully-remaining edition weights to 1", () => {
    expect(survivorPoolWeight(100, 100)).toBe(1)
  })
})

describe("mergeRemainingByEdition — de-dupe the one-node-per-slot shape", () => {
  it("sums count + remaining per edition uuid", () => {
    const merged = mergeRemainingByEdition([
      { edId: "a", count: 3, remaining: 2 },
      { edId: "b", count: 5, remaining: 5 },
      { edId: "a", count: 1, remaining: 4 },
    ])
    expect(merged).toEqual([
      { edId: "a", count: 4, remaining: 6 },
      { edId: "b", count: 5, remaining: 5 },
    ])
  })
  it("preserves first-seen order", () => {
    const merged = mergeRemainingByEdition([
      { edId: "z", count: 1, remaining: 1 },
      { edId: "y", count: 1, remaining: 1 },
      { edId: "z", count: 1, remaining: 1 },
    ])
    expect(merged.map((m) => m.edId)).toEqual(["z", "y"])
  })
  it("a single node passes through unchanged", () => {
    expect(mergeRemainingByEdition([{ edId: "a", count: 2, remaining: 1 }])).toEqual([
      { edId: "a", count: 2, remaining: 1 },
    ])
  })
  it("empty input → empty output", () => {
    expect(mergeRemainingByEdition([])).toEqual([])
  })
})

describe("clampTopshotEv — persisted $ bounds [-10000, 1e6]", () => {
  it("passes a value inside the window through", () => {
    expect(clampTopshotEv(86.42)).toBe(86.42)
  })
  it("clamps a runaway high value to 1e6 (the P0 shape: a five/six-figure EV)", () => {
    expect(clampTopshotEv(2_651.21)).toBe(2651.21) // in-window, kept
    expect(clampTopshotEv(9_999_999)).toBe(1_000_000)
  })
  it("clamps a runaway negative to -10000", () => {
    expect(clampTopshotEv(-50_000)).toBe(-10_000)
  })
})

describe("shapeTopshotEvRow — the post-RPC shaping a collector actually sees", () => {
  it("computes pack_ev / value_ratio / is_positive / depletion for a normal priced pack", () => {
    const r = shapeTopshotEvRow({
      grossEv: 86,
      packPrice: 10,
      priceSource: "primary",
      totalPackCount: 1000,
      totalUnopened: 250,
      typicalPullEv: 26,
    })
    expect(r.grossEv).toBe(86)
    expect(r.packEv).toBe(76) // 86 − 10
    expect(r.isPositiveEv).toBe(true)
    expect(r.valueRatio).toBe(8.6) // 86 / 10, 3dp
    expect(r.depletionPct).toBe(75) // (1000 − 250) / 1000
    expect(r.typicalEv).toBe(26)
  })

  it("pack_ev overrides to gross_ev − packPrice (2dp), not the RPC's own pack_ev", () => {
    const r = shapeTopshotEvRow({
      grossEv: 12.345,
      packPrice: 5,
      priceSource: "secondary",
      totalPackCount: 0,
      totalUnopened: 0,
      typicalPullEv: null,
    })
    expect(r.packEv).toBe(7.35) // round((12.345 − 5) * 100) / 100 = 7.35
  })

  it("price_source 'none' suppresses is_positive_ev even with a positive gross EV", () => {
    const r = shapeTopshotEvRow({
      grossEv: 500,
      packPrice: 0,
      priceSource: "none",
      totalPackCount: 100,
      totalUnopened: 100,
      typicalPullEv: 50,
    })
    expect(r.isPositiveEv).toBe(false)
    // no price → value_ratio is null (no fabricated multiple), not Infinity
    expect(r.valueRatio).toBeNull()
    // fully unopened → 0% depletion
    expect(r.depletionPct).toBe(0)
  })

  it("value_ratio is null (division guard) whenever packPrice is 0", () => {
    expect(
      shapeTopshotEvRow({
        grossEv: 100,
        packPrice: 0,
        priceSource: "primary",
        totalPackCount: 10,
        totalUnopened: 5,
        typicalPullEv: null,
      }).valueRatio,
    ).toBeNull()
  })

  it("depletion_pct is null when total supply is unknown (never a false 0%)", () => {
    expect(
      shapeTopshotEvRow({
        grossEv: 10,
        packPrice: 5,
        priceSource: "primary",
        totalPackCount: 0,
        totalUnopened: 0,
        typicalPullEv: null,
      }).depletionPct,
    ).toBeNull()
  })

  it("depletion_pct clamps to [0,100] on noisy supply inputs", () => {
    // available > total (upstream noise) → clamped to 0, not negative
    expect(
      shapeTopshotEvRow({
        grossEv: 10,
        packPrice: 5,
        priceSource: "primary",
        totalPackCount: 100,
        totalUnopened: 150,
        typicalPullEv: null,
      }).depletionPct,
    ).toBe(0)
    // fully sold → 100
    expect(
      shapeTopshotEvRow({
        grossEv: 10,
        packPrice: 5,
        priceSource: "primary",
        totalPackCount: 100,
        totalUnopened: 0,
        typicalPullEv: null,
      }).depletionPct,
    ).toBe(100)
  })

  it("clamps a runaway gross/pack EV before persistence (the P0 guard)", () => {
    const r = shapeTopshotEvRow({
      grossEv: 5_000_000,
      packPrice: 4.99,
      priceSource: "primary",
      totalPackCount: 500,
      totalUnopened: 500,
      typicalPullEv: 3_000_000,
    })
    expect(r.grossEv).toBe(1_000_000)
    expect(r.packEv).toBe(1_000_000)
    expect(r.typicalEv).toBe(1_000_000)
  })

  it("a negative-EV pack reports is_positive_ev false", () => {
    const r = shapeTopshotEvRow({
      grossEv: 3,
      packPrice: 10,
      priceSource: "primary",
      totalPackCount: 100,
      totalUnopened: 10,
      typicalPullEv: 2,
    })
    expect(r.packEv).toBe(-7)
    expect(r.isPositiveEv).toBe(false)
  })

  it("typical_ev is null exactly when the RPC returned no median", () => {
    expect(
      shapeTopshotEvRow({
        grossEv: 10,
        packPrice: 5,
        priceSource: "primary",
        totalPackCount: 10,
        totalUnopened: 5,
        typicalPullEv: null,
      }).typicalEv,
    ).toBeNull()
    expect(
      shapeTopshotEvRow({
        grossEv: 10,
        packPrice: 5,
        priceSource: "primary",
        totalPackCount: 10,
        totalUnopened: 5,
        typicalPullEv: undefined,
      }).typicalEv,
    ).toBeNull()
  })
})

describe("edge-fn source-drift guard — the Top Shot inline copies cannot silently diverge", () => {
  // compute-topshot-pack-ev/index.ts carries these formulas inline (it delegates
  // the weighted EV to the DB RPC but shapes/weights in JS). It is deliberately
  // un-redeployed (CLAUDE.md), so rewiring it to import from _shared is a
  // deploy-gated follow-up. Until then this guard enforces "keep in sync"
  // mechanically: the edge fn must EITHER import from _shared/topshot-pack-ev
  // (drift impossible) OR still carry each canonical expression verbatim
  // (whitespace-normalized). An un-mirrored edit to either copy reddens CI.
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(path.join(root, "supabase/functions/compute-topshot-pack-ev/index.ts"), "utf8"),
  )
  const importsShared = /from\s+["'][^"']*_shared\/topshot-pack-ev/.test(edgeSrc)

  const PACK_EV = norm("Math.round((grossEv - dual.packPrice) * 100) / 100")
  const IS_POSITIVE = norm('dual.priceSource !== "none" && packEv > 0')
  const VALUE_RATIO = norm("Math.round((grossEv / dual.packPrice) * 1000) / 1000")
  const DEPLETION = norm(
    "Math.min(100, Math.max(0, Math.round(((f.totalPackCount - f.totalUnopened) / f.totalPackCount) * 100)))",
  )
  const CLAMP = norm("Math.max(-10000, Math.min(1000000, v))")
  const WEIGHT = norm("f.totalUnopened > 0 ? m.remaining / f.totalUnopened : 0")
  const TYPICAL = norm("ev.typical_pull_ev != null ? clamp(Number(ev.typical_pull_ev)) : null")

  it.each([
    ["pack_ev override", PACK_EV],
    ["is_positive_ev suppression", IS_POSITIVE],
    ["value_ratio division guard", VALUE_RATIO],
    ["depletion_pct clamp", DEPLETION],
    ["persisted-$ clamp", CLAMP],
    ["survivor pool weight", WEIGHT],
    ["typical_ev clamp/null", TYPICAL],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })

  it("the extracted shaping still reproduces the pinned inline result", () => {
    // Mirrors the exact inline path for a representative priced pack, so the
    // guard's expression check and the unit result can't drift apart.
    const r = shapeTopshotEvRow({
      grossEv: 86,
      packPrice: 10,
      priceSource: "primary",
      totalPackCount: 1000,
      totalUnopened: 250,
      typicalPullEv: 26,
    })
    expect(r.packEv).toBe(86 - 10)
    expect(r.valueRatio).toBe(Math.round((86 / 10) * 1000) / 1000)
    expect(r.depletionPct).toBe(Math.min(100, Math.max(0, Math.round(((1000 - 250) / 1000) * 100))))
  })
})
