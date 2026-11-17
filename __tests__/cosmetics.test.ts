import { describe, it, expect } from "vitest"
import {
  borderCosmetic,
  bannerCosmetic,
  hasCosmeticStyle,
  BORDER_COSMETICS,
  BANNER_COSMETICS,
} from "@/lib/cosmetics"

// lib/cosmetics.ts — the shared cosmetic style maps for profile Border/Banner.
// Pins the lookup helpers: known SKU → its style, null/empty → null, and the
// prototype-key own-property guard (a stored equipped_border of "toString" must
// resolve to null, not the inherited Object.prototype.toString function).

describe("borderCosmetic", () => {
  it("returns the style for a known border SKU", () => {
    expect(borderCosmetic("classic")).toEqual(BORDER_COSMETICS.classic)
    expect(borderCosmetic("flame")).toEqual(BORDER_COSMETICS.flame)
    expect(borderCosmetic("ice")).toEqual(BORDER_COSMETICS.ice)
    expect(borderCosmetic("gold")).toEqual(BORDER_COSMETICS.gold)
  })

  it("returns null for null / undefined / empty input", () => {
    expect(borderCosmetic(null)).toBeNull()
    expect(borderCosmetic(undefined)).toBeNull()
    expect(borderCosmetic("")).toBeNull()
  })

  it("returns null for an unknown SKU (a future cosmetic never throws)", () => {
    expect(borderCosmetic("does-not-exist")).toBeNull()
  })

  it("returns null for a prototype-key value, not a prototype member", () => {
    for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(borderCosmetic(key), key).toBeNull()
    }
  })
})

describe("bannerCosmetic", () => {
  it("returns the style for a known banner SKU", () => {
    expect(bannerCosmetic("ripcity")).toEqual(BANNER_COSMETICS.ripcity)
    expect(bannerCosmetic("nova")).toEqual(BANNER_COSMETICS.nova)
  })

  it("returns null for null / undefined / empty input", () => {
    expect(bannerCosmetic(null)).toBeNull()
    expect(bannerCosmetic(undefined)).toBeNull()
    expect(bannerCosmetic("")).toBeNull()
  })

  it("returns null for an unknown SKU", () => {
    expect(bannerCosmetic("does-not-exist")).toBeNull()
  })

  it("returns null for a prototype-key value, not a prototype member", () => {
    for (const key of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(bannerCosmetic(key), key).toBeNull()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// hasCosmeticStyle — the join the catalogue never had.
//
// A cosmetic SKU is a row in `shop_items` (metadata `{slot, value}`), which is a
// pure DB insert with no deploy. Its APPEARANCE is the maps above, which ship
// with the bundle. Nothing connected the two, and both lookups fail SOFT by
// design — so a SKU sold ahead of its style took the collector's credits, wrote
// itself to their profile, and rendered as nothing, with no error on any
// surface. The rewards shop and the owned-cosmetics list now ask this first.
// ─────────────────────────────────────────────────────────────────────────────

describe("hasCosmeticStyle", () => {
  it("is true for every SKU currently sold in the shop", () => {
    // Measured live 2026-08-14: shop_items type='cosmetic' is exactly these six,
    // and all six resolve. This asserts the two halves are in agreement TODAY —
    // if a style is deleted without pulling the SKU, this reds.
    for (const v of ["classic", "flame", "ice", "gold"]) {
      expect(hasCosmeticStyle("border", v), v).toBe(true)
    }
    for (const v of ["ripcity", "nova"]) {
      expect(hasCosmeticStyle("banner", v), v).toBe(true)
    }
  })

  it("is false for a SKU whose style has not shipped", () => {
    expect(hasCosmeticStyle("border", "neon")).toBe(false)
    expect(hasCosmeticStyle("banner", "aurora")).toBe(false)
  })

  it("does not accept a value from the OTHER slot's map", () => {
    // The slots are separate namespaces. Reading a banner value as a border
    // would sell a ring that draws as nothing — the exact failure this guards.
    expect(hasCosmeticStyle("border", "ripcity")).toBe(false)
    expect(hasCosmeticStyle("banner", "gold")).toBe(false)
  })

  it("is false for an unknown or missing slot", () => {
    // ⚠ Fails CLOSED. A cosmetic we cannot classify is one we cannot draw, and
    // "sellable" is the wrong way to be wrong when credits change hands.
    expect(hasCosmeticStyle("avatar", "classic")).toBe(false)
    expect(hasCosmeticStyle(null, "classic")).toBe(false)
    expect(hasCosmeticStyle(undefined, "classic")).toBe(false)
  })

  it("is false for a missing value", () => {
    expect(hasCosmeticStyle("border", null)).toBe(false)
    expect(hasCosmeticStyle("border", undefined)).toBe(false)
    expect(hasCosmeticStyle("border", "")).toBe(false)
  })

  it("is false for a prototype key", () => {
    // Same reason the lookups carry an own-property guard: `value` mirrors a
    // user-writable column, and a truthy prototype member would read as a
    // renderable cosmetic here.
    for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(hasCosmeticStyle("border", key), key).toBe(false)
      expect(hasCosmeticStyle("banner", key), key).toBe(false)
    }
  })
})
