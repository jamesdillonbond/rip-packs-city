import { describe, it, expect } from "vitest"
import { priceMatchesCents, topShotMomentUrl } from "@/lib/verify-wallet-gql"

// priceMatchesCents backs the wallet listing-challenge: the user lists a moment
// at a unique price and we confirm it matches to the cent before crediting the
// wallet. A loose comparison would let a near-miss falsely verify ownership.

describe("priceMatchesCents", () => {
  it("matches to the cent", () => {
    expect(priceMatchesCents(10.0, 10.0)).toBe(true)
    expect(priceMatchesCents(10.01, 10.01)).toBe(true)
    // float noise that rounds to the same cent still matches
    expect(priceMatchesCents(10.005 + 0.005, 10.01)).toBe(true)
  })

  it("rejects a mismatch by a cent or more", () => {
    expect(priceMatchesCents(10.0, 10.01)).toBe(false)
    expect(priceMatchesCents(9.99, 10.0)).toBe(false)
  })

  it("rejects null / non-finite price", () => {
    expect(priceMatchesCents(null, 10)).toBe(false)
    expect(priceMatchesCents(Infinity, 10)).toBe(false)
    expect(priceMatchesCents(NaN, 10)).toBe(false)
  })
})

describe("topShotMomentUrl", () => {
  it("builds the native moment page url, encoding the id", () => {
    expect(topShotMomentUrl("999")).toBe("https://nbatopshot.com/moment/999")
    expect(topShotMomentUrl("a b")).toBe("https://nbatopshot.com/moment/a%20b")
  })
})
