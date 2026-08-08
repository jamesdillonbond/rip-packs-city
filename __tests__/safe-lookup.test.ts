import { describe, it, expect } from "vitest"
import { ownLookup } from "@/lib/safe-lookup"
import { toDbSlug, fromDbSlug, getCollectionUuid } from "@/lib/collections"
import { packEvBasis } from "@/lib/pack-availability"

// lib/safe-lookup.ts — the shared own-property guard, plus regression coverage
// at the externally-keyed call sites now routed through it. A bare `map[key]`
// read resolves a crafted "constructor"/"toString"/etc. to a truthy
// Object.prototype member, which defeats a `?? fallback` and surfaces a function
// where a value is expected.

const PROTO_KEYS = ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__", "isPrototypeOf"]

describe("ownLookup", () => {
  const MAP: Record<string, number> = { a: 1, b: 2, zero: 0 }

  it("returns the value for an own key (including a falsy 0)", () => {
    expect(ownLookup(MAP, "a")).toBe(1)
    expect(ownLookup(MAP, "zero")).toBe(0)
  })

  it("returns undefined for a missing own key", () => {
    expect(ownLookup(MAP, "nope")).toBeUndefined()
  })

  it("returns undefined for null / undefined key", () => {
    expect(ownLookup(MAP, null)).toBeUndefined()
    expect(ownLookup(MAP, undefined)).toBeUndefined()
  })

  it("returns undefined for inherited Object.prototype keys (the whole point)", () => {
    for (const key of PROTO_KEYS) {
      expect(ownLookup(MAP, key), key).toBeUndefined()
    }
  })

  it("still returns own values that happen to shadow a prototype name", () => {
    const shadow: Record<string, string> = { toString: "real", constructor: "mine" }
    expect(ownLookup(shadow, "toString")).toBe("real")
    expect(ownLookup(shadow, "constructor")).toBe("mine")
  })
})

describe("collections slug resolvers reject prototype-key slugs", () => {
  it("real slugs still resolve", () => {
    expect(toDbSlug("nba-top-shot")).toBe("nba_top_shot")
    expect(fromDbSlug("nba_top_shot")).toBe("nba-top-shot")
    expect(getCollectionUuid("nba-top-shot")).toBe("95f28a17-224a-4025-96ad-adf8a4c63bfd")
  })
  for (const key of PROTO_KEYS) {
    it(`toDbSlug/fromDbSlug/getCollectionUuid("${key}") → null, not a prototype member`, () => {
      expect(toDbSlug(key)).toBeNull()
      expect(fromDbSlug(key)).toBeNull()
      expect(getCollectionUuid(key)).toBeNull()
    })
  }
})

describe("packEvBasis rejects prototype-key slugs", () => {
  for (const key of PROTO_KEYS) {
    it(`packEvBasis("${key}") → null`, () => {
      expect(packEvBasis(key)).toBeNull()
    })
  }
})
