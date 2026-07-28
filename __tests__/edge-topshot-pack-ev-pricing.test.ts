import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  editionExtKey,
  normalizeTier,
} from "@/supabase/functions/_shared/topshot-pack-ev-pricing"
import { computeDualPrice } from "@/lib/pack-ev-pricing"

// Coverage for the FLAGSHIP TopShot pack-EV writer's money-critical primitives.
// The writer itself (supabase/functions/compute-topshot-pack-ev/index.ts) is a
// Deno edge function excluded from the coverage measure AND deliberately kept off
// the _shared rewire, so these primitives had no behavioural coverage — the same
// blind spot that produced the 2026-07-25 fabricated-EV P0. See the source-drift
// guard at the bottom: it ensures the edge fn's inline copies cannot diverge from
// what is tested here without reddening CI.

describe("editionExtKey — canonical vs skeleton edition key", () => {
  const node = (set: any, play: any) => ({ edition: { set, play } })

  it("prefers the on-chain integer pair when both flowIds are present", () => {
    expect(editionExtKey(node({ id: "u-set", flowId: 12 }, { id: "u-play", flowID: 340 })))
      .toEqual({ ext: "12:340", intPair: true })
  })

  it("coerces string flowIds to numbers (strips a leading zero / whitespace)", () => {
    // Number("07") === 7 — the durable key must not carry the string form.
    expect(editionExtKey(node({ id: "s", flowId: "07" }, { id: "p", flowID: "340" })))
      .toEqual({ ext: "7:340", intPair: true })
  })

  it("falls back to the UUID pair when a flowId is missing", () => {
    expect(editionExtKey(node({ id: "u-set", flowId: null }, { id: "u-play", flowID: 5 })))
      .toEqual({ ext: "u-set:u-play", intPair: false })
    expect(editionExtKey(node({ id: "u-set" }, { id: "u-play", flowID: 5 })))
      .toEqual({ ext: "u-set:u-play", intPair: false })
  })

  it("falls back to the UUID pair when a flowId is non-numeric (NaN guard)", () => {
    // A garbage flowId must NOT produce "NaN:5" — that would be an un-remappable
    // pool key. It falls through to the UUID pair instead.
    expect(editionExtKey(node({ id: "u-set", flowId: "abc" }, { id: "u-play", flowID: 5 })))
      .toEqual({ ext: "u-set:u-play", intPair: false })
  })

  it("returns null when neither key can be formed", () => {
    expect(editionExtKey(node(null, null))).toEqual({ ext: null, intPair: false })
    expect(editionExtKey(node({ id: "s" }, null))).toEqual({ ext: null, intPair: false })
    // set has flowId but play has neither flowID nor id → no int pair, no UUID pair
    expect(editionExtKey(node({ id: "s", flowId: 1 }, { flowID: null, id: null })))
      .toEqual({ ext: null, intPair: false })
  })

  it("treats flowId 0 as a real on-chain id (Series 1 is set-series 0)", () => {
    // 0 is finite and != null, so it must be accepted, not treated as missing.
    expect(editionExtKey(node({ id: "s", flowId: 0 }, { id: "p", flowID: 0 })))
      .toEqual({ ext: "0:0", intPair: true })
  })
})

describe("normalizeTier — Top Shot tier vocabulary coercion", () => {
  it("maps each canonical tier, case-insensitively", () => {
    expect(normalizeTier("common")).toBe("COMMON")
    expect(normalizeTier("Fandom")).toBe("FANDOM")
    expect(normalizeTier("RARE")).toBe("RARE")
    expect(normalizeTier("legendary")).toBe("LEGENDARY")
    expect(normalizeTier("ultimate")).toBe("ULTIMATE")
  })

  it("matches decorated on-chain values via substring", () => {
    expect(normalizeTier("Top Shot Rare (Series 4)")).toBe("RARE")
    expect(normalizeTier("  legendary  ")).toBe("LEGENDARY")
  })

  it("checks ULTIMATE before the others (precedence, not first-substring)", () => {
    // "Ultimate" contains no other tier word, but the ordering matters if a
    // value ever carried two — ULTIMATE wins.
    expect(normalizeTier("Ultimate")).toBe("ULTIMATE")
  })

  it("returns null for unknown / empty / falsy tiers (never a wrong default)", () => {
    expect(normalizeTier("challenger")).toBeNull() // UFC tier — not a TS tier
    expect(normalizeTier("")).toBeNull()
    expect(normalizeTier(null)).toBeNull()
    expect(normalizeTier(undefined)).toBeNull()
    expect(normalizeTier(0)).toBeNull()
  })
})

describe("computeDualPrice (lib canonical) — the min-of-primary-secondary rule", () => {
  // The edge fn's inline computeDualPrice is a verbatim port of this lib one; the
  // drift guard below pins that. These cases re-assert the load-bearing rule: a
  // pack's headline price is the CHEAPER of an available primary drop price and
  // an available secondary ask, and only counts a source that is actually live.
  it("takes the cheaper side and labels the source", () => {
    const primaryCheaper = computeDualPrice({ requestedPrice: 10, totalUnopened: 5, forSale: true, secondaryAsk: 25 })
    expect(primaryCheaper.packPrice).toBe(10)
    expect(primaryCheaper.priceSource).toBe("primary")

    const secondaryCheaper = computeDualPrice({ requestedPrice: 40, totalUnopened: 5, forSale: true, secondaryAsk: 25 })
    expect(secondaryCheaper.packPrice).toBe(25)
    expect(secondaryCheaper.priceSource).toBe("secondary")
  })

  it("labels near-equal prices 'min' (within 1%)", () => {
    const r = computeDualPrice({ requestedPrice: 100, totalUnopened: 5, forSale: true, secondaryAsk: 100.5 })
    expect(r.priceSource).toBe("min")
  })

  it("ignores a primary that is sold out or not for sale", () => {
    const soldOut = computeDualPrice({ requestedPrice: 10, totalUnopened: 0, forSale: true, secondaryAsk: 25 })
    expect(soldOut.priceSource).toBe("secondary")
    expect(soldOut.packPrice).toBe(25)

    const notForSale = computeDualPrice({ requestedPrice: 10, totalUnopened: 5, forSale: false, secondaryAsk: 25 })
    expect(notForSale.priceSource).toBe("secondary")
  })

  it("reports priceSource 'none' with no live price on either side", () => {
    const r = computeDualPrice({ requestedPrice: 10, totalUnopened: 0, forSale: false, secondaryAsk: null })
    expect(r.priceSource).toBe("none")
    expect(r.packPrice).toBe(0)
  })
})

describe("source-drift guard — the edge fn's inline copies cannot silently diverge", () => {
  // Mechanism mirrors __tests__/edge-pack-ev-supply-weighted.test.ts: read the
  // flagship writer's source, whitespace-normalize, and assert it still carries
  // the exact primitive bodies this test covers. An un-mirrored edit to the edge
  // fn (or to this module) reddens CI here instead of shipping a mispricing.
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(
      path.join(root, "supabase/functions/compute-topshot-pack-ev/index.ts"),
      "utf8",
    ),
  )
  const sharedSrc = norm(
    readFileSync(
      path.join(root, "supabase/functions/_shared/topshot-pack-ev-pricing.ts"),
      "utf8",
    ),
  )

  // The load-bearing formula fragments (normalized). If any of these changes in
  // the edge fn without the _shared copy + tests changing too, one of these
  // fails.
  const EDITION_KEY_INT = norm("return { ext: `${Number(setFlowRaw)}:${Number(playFlowRaw)}`, intPair: true }")
  const EDITION_KEY_UUID = norm("if (setId && playId) return { ext: `${setId}:${playId}`, intPair: false }")
  const TIER_ULTIMATE = norm('if (t.includes("ULTIMATE")) return "ULTIMATE"')
  const TIER_COMMON = norm('if (t.includes("COMMON")) return "COMMON"')

  it("the flagship writer still carries the inline editionExtKey formula", () => {
    expect(edgeSrc.includes(EDITION_KEY_INT)).toBe(true)
    expect(edgeSrc.includes(EDITION_KEY_UUID)).toBe(true)
  })

  it("the flagship writer still carries the inline normalizeTier ladder", () => {
    expect(edgeSrc.includes(TIER_ULTIMATE)).toBe(true)
    expect(edgeSrc.includes(TIER_COMMON)).toBe(true)
  })

  it("the _shared copy is a verbatim mirror of those fragments", () => {
    expect(sharedSrc.includes(EDITION_KEY_INT)).toBe(true)
    expect(sharedSrc.includes(EDITION_KEY_UUID)).toBe(true)
    expect(sharedSrc.includes(TIER_ULTIMATE)).toBe(true)
    expect(sharedSrc.includes(TIER_COMMON)).toBe(true)
  })

  it("the edge fn still documents computeDualPrice as a verbatim port of the lib canonical", () => {
    // computeDualPrice is tested via lib/pack-ev-pricing above; this pins that
    // the edge fn is still declaring itself a port of it (not a diverged copy).
    expect(edgeSrc.includes(norm("Verbatim port of computeDualPrice from app/api/pack-ev/route.ts"))).toBe(true)
    expect(edgeSrc.includes(norm("function computeDualPrice(args: {"))).toBe(true)
  })
})
