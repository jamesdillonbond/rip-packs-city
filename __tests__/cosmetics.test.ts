import { describe, it, expect } from "vitest"
import {
  borderCosmetic,
  bannerCosmetic,
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
