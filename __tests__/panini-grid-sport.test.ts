import { describe, it, expect } from "vitest"
import { appliedSportOf, sameSport } from "../scripts/panini-grid-sport.mjs"

const body = (af: string) => JSON.stringify({ operationName: "products", variables: { input: { applied_filters: af, page: 2 } } })

describe("appliedSportOf — the sport a Panini grid request actually applied (2026-11-22)", () => {
  it("reads the sport out of applied_filters, URL-decoded", () => {
    expect(appliedSportOf(body("marketplace-nfts?sport=Soccer&p=4"))).toBe("Soccer")
    expect(appliedSportOf(body("marketplace-nfts?sport=Womens%20Soccer&p=1"))).toBe("Womens Soccer")
    expect(appliedSportOf(body("marketplace-nfts?p=3&sport=Womens+Basketball"))).toBe("Womens Basketball")
  })

  it("names a mismatch: the runner's 'Womens Soccer' pass that the site served as Basketball", () => {
    const applied = appliedSportOf(body("marketplace-nfts?sport=Basketball&p=7"))
    expect(applied).toBe("Basketball")
    expect(sameSport(applied, "Womens Soccer")).toBe(false)
  })

  it("returns null when the body names no sport — the loop's sport is then the fallback", () => {
    expect(appliedSportOf(body("marketplace-nfts?p=1"))).toBeNull()
    expect(appliedSportOf(JSON.stringify({ variables: {} }))).toBeNull()
    expect(appliedSportOf("not json")).toBeNull()
    expect(appliedSportOf("")).toBeNull()
  })

  it("compares sports ignoring case and spacing, never matching an empty value", () => {
    expect(sameSport("WOMENS SOCCER", "Womens  Soccer")).toBe(true)
    expect(sameSport("Soccer", "Womens Soccer")).toBe(false)
    expect(sameSport("", "")).toBe(false)
    expect(sameSport(null, "Soccer")).toBe(false)
  })
})
