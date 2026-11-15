import { describe, it, expect } from "vitest"
import { isSafeChallengeTarget, MAX_SAFE_TARGET_FMV } from "@/lib/verify-challenge-target"

// 2026-11-15: a listing-challenge target must be cheap enough that the capped
// ($999) challenge price is still ≥ 10× its value.
describe("isSafeChallengeTarget", () => {
  it("accepts dust and anything up to the line; refuses above it", () => {
    expect(isSafeChallengeTarget(0.19)).toBe(true)
    expect(isSafeChallengeTarget(MAX_SAFE_TARGET_FMV)).toBe(true)
    expect(isSafeChallengeTarget(100)).toBe(false)
    expect(MAX_SAFE_TARGET_FMV * 10).toBeLessThanOrEqual(999)
  })
  it("an unknown value stays eligible (the route then uses its $10 floor price)", () => {
    expect(isSafeChallengeTarget(null)).toBe(true)
  })
})
