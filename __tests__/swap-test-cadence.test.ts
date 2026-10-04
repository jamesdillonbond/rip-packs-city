import { describe, it, expect } from "vitest"
import { MAX_SWAP_SIDE, SWAP_CADENCE, SWAP_GAS_LIMIT, SWAP_SIMULATION_SCRIPT, borrowSide, moveSide } from "@/lib/swap-test/swap-cadence"

// The simulation is only evidence about the transaction if both run the SAME legs.
// Measured 2026-10-03 on mainnet (read-only): the simulation moved Trevor's moment
// 27289790 from his linked Dapper account 0xbd94… (via 0x3d0b…, controller 87) into
// 0xd96d…, returning [true].

describe("swap-test/swap-cadence", () => {
  it("the transaction and the simulation share both borrow legs and both transfer legs verbatim", () => {
    for (const src of [SWAP_CADENCE, SWAP_SIMULATION_SCRIPT]) {
      expect(src).toContain(borrowSide("a", "A"))
      expect(src).toContain(borrowSide("b", "B"))
    }
    expect(SWAP_CADENCE).toContain(moveSide("A", "B", "self.pA"))
    expect(SWAP_CADENCE).toContain(moveSide("B", "A", "self.pB"))
    expect(SWAP_SIMULATION_SCRIPT).toContain(moveSide("A", "B", "providerA"))
    expect(SWAP_SIMULATION_SCRIPT).toContain(moveSide("B", "A", "providerB"))
    // the move legs differ ONLY in the provider reference
    expect(moveSide("A", "B", "self.pA").replace("self.pA", "providerA")).toBe(moveSide("A", "B", "providerA"))
  })

  it("is ONE transaction with TWO authorizers, A first — the order the wallets are passed in", () => {
    expect(SWAP_CADENCE).toMatch(/prepare\(a: auth\(BorrowValue\) &Account, b: auth\(BorrowValue\) &Account\)/)
    expect(SWAP_CADENCE.match(/\bprepare\(/g)).toHaveLength(1)
    expect(SWAP_CADENCE).toContain(
      "transaction(sourceA: Address, ctlA: UInt64, idsA: [UInt64], sourceB: Address, ctlB: UInt64, idsB: [UInt64])",
    )
  })

  it("each side's moments go to the OTHER side's account, never its own", () => {
    expect(moveSide("A", "B", "x")).toContain("getAccount(sourceB)")
    expect(moveSide("A", "B", "x")).not.toContain("getAccount(sourceA)")
    expect(moveSide("B", "A", "x")).toContain("getAccount(sourceA)")
  })

  it("is all-or-nothing on chain: every leg panics rather than skipping a moment", () => {
    // no `if let` around a withdraw: a missing / locked moment reverts the whole transaction
    expect(moveSide("A", "B", "p")).toContain("p!.withdraw(withdrawID: id)")
    expect(moveSide("A", "B", "p")).toMatch(/\?\? panic\(/)
    expect(SWAP_CADENCE).toContain('assert(idsA.length + idsB.length > 0, message: "nothing to swap")')
    expect(SWAP_CADENCE).toContain("assert(sourceA != sourceB")
  })

  it("an own side borrows the SIGNER's collection; a linked side goes through Hybrid Custody", () => {
    const leg = borrowSide("a", "A")
    expect(leg).toContain("if sourceA == a.address {")
    expect(leg).toContain("a.storage\n                    .borrow<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>(from: /storage/MomentCollection)")
    expect(leg).toContain("manager.borrowAccount(addr: sourceA)".replace("manager", "managerA"))
    expect(leg).toContain("controllerID: ctlA")
  })

  it("moves Top Shot moments only, within bounded sides and gas", () => {
    expect(moveSide("A", "B", "p")).toContain("Type<@TopShot.NFT>()")
    expect(borrowSide("a", "A")).toContain(`assert(idsA.length <= ${MAX_SWAP_SIDE}`)
    expect(MAX_SWAP_SIDE).toBe(10)
    expect(SWAP_GAS_LIMIT).toBe(9999)
    // the only contracts touched are the three imports
    const imports = [...SWAP_CADENCE.matchAll(/^import (\w+) from (0x[0-9a-f]+)$/gm)].map((m) => `${m[1]}@${m[2]}`)
    expect(imports).toEqual(["HybridCustody@0xd8a7e05a7ac670c0", "NonFungibleToken@0x1d7e57aa55817448", "TopShot@0x0b2a3299cc857e29"])
  })
})
