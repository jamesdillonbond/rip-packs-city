import { describe, it, expect } from "vitest"
import { redeemSuccessMessage, redeemErrorReason } from "@/lib/rewards-redeem-message"

describe("redeemSuccessMessage", () => {
  it("pro → immediate Pro activation copy (ignores name)", () => {
    expect(redeemSuccessMessage("pro", "Anything", null)).toBe("RPC Pro activated — 30 days. Enjoy.")
  })
  it("cosmetic → equipped-on-profile copy with the item name", () => {
    expect(redeemSuccessMessage("cosmetic", "Gold Border", null)).toBe('Equipped "Gold Border" on your profile.')
  })
  it("moment with a resolved username → names the gift target", () => {
    expect(redeemSuccessMessage("moment", "LeBron Dunk", "trevor")).toBe(
      'Redeemed "LeBron Dunk". We\'ll gift it to @trevor on Top Shot — track it below.'
    )
  })
  it("moment without a resolved username → asks for the Top Shot username", () => {
    expect(redeemSuccessMessage("moment", "LeBron Dunk", null)).toBe(
      'Redeemed "LeBron Dunk". Tell us the Top Shot username to gift it to — track it below.'
    )
    // empty string is falsy → same branch
    expect(redeemSuccessMessage("moment", "X", "")).toContain("Tell us the Top Shot username")
  })
  it("merch → collect-shipping copy", () => {
    expect(redeemSuccessMessage("merch", "RPC Tee", null)).toBe(
      'Redeemed "RPC Tee". Add your shipping address so we can send it.'
    )
  })
  it("unknown/null type → generic track-below copy", () => {
    expect(redeemSuccessMessage("something-else", "Item", null)).toBe('Redeemed "Item". Track it below.')
    expect(redeemSuccessMessage(null, "Item", null)).toBe('Redeemed "Item". Track it below.')
    expect(redeemSuccessMessage(undefined, "Item", "user")).toBe('Redeemed "Item". Track it below.')
  })
})

describe("redeemErrorReason", () => {
  it("maps each known error code to its human copy", () => {
    expect(redeemErrorReason("insufficient_credits")).toBe("Not enough Credits.")
    expect(redeemErrorReason("out_of_stock")).toBe("That one's out of stock.")
    expect(redeemErrorReason("status_too_low")).toBe("You haven't reached the required tier yet.")
    expect(redeemErrorReason("per_user_limit_reached")).toBe("You've already redeemed this.")
  })
  it("falls back to the generic reason for unknown/null/undefined", () => {
    expect(redeemErrorReason("weird_code")).toBe("Couldn't redeem that item.")
    expect(redeemErrorReason(null)).toBe("Couldn't redeem that item.")
    expect(redeemErrorReason(undefined)).toBe("Couldn't redeem that item.")
    expect(redeemErrorReason("")).toBe("Couldn't redeem that item.")
  })
})
