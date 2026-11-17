import { describe, it, expect } from "vitest"
import {
  BORROW_OWN_PROVIDER,
  BORROW_PROVIDER,
  DELIVER_OWN_BATCH_CADENCE,
  DELIVER_OWN_SIMULATION_SCRIPT,
  LINKED_ACCOUNTS_SCRIPT,
  DELIVER_BATCH_CADENCE,
  DELIVER_GAS_LIMIT,
  DELIVER_SIMULATION_SCRIPT,
  MAX_DELIVERY_BATCH,
  PROVIDER_CONTROLLERS_SCRIPT,
  deliverLoop,
} from "@/lib/giveaways/deliver-cadence"
import { GIFT_MOMENT_CADENCE } from "@/lib/chains/flow/cadence/gift-moment"

// The simulation is only evidence about the transaction if they run the SAME
// statements. Measured 2026-09-29 on mainnet: the simulation moved two of
// Trevor's giftable moments in memory ([true, true]) and refused a locked one
// with Top Shot's own "Cannot withdraw: Moment is locked".

describe("giveaways/deliver-cadence", () => {
  it("the transaction and the simulation share the provider borrow and the transfer loop verbatim", () => {
    expect(DELIVER_BATCH_CADENCE).toContain(BORROW_PROVIDER)
    expect(DELIVER_SIMULATION_SCRIPT).toContain(BORROW_PROVIDER)
    expect(DELIVER_BATCH_CADENCE).toContain(deliverLoop("self.provider"))
    expect(DELIVER_SIMULATION_SCRIPT).toContain(deliverLoop("provider"))
    // the loop bodies differ ONLY in the provider reference
    expect(deliverLoop("self.provider").replace("self.provider", "provider")).toBe(deliverLoop("provider"))
  })

  it("the simulation borrows from the PARENT's account, as the transaction's signer would", () => {
    expect(DELIVER_SIMULATION_SCRIPT).toContain("let parent = getAuthAccount<auth(BorrowValue) &Account>(parentAddress)")
    expect(DELIVER_BATCH_CADENCE).toContain("prepare(parent: auth(BorrowValue) &Account)")
  })

  it("uses the contract addresses and withdraw path of the verified single-gift transaction", () => {
    for (const line of [
      "import HybridCustody from 0xd8a7e05a7ac670c0",
      "import NonFungibleToken from 0x1d7e57aa55817448",
      "import TopShot from 0x0b2a3299cc857e29",
      "HybridCustody.ManagerStoragePath",
      "/public/MomentCollection",
      "Type<auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}>()",
    ]) {
      expect(GIFT_MOMENT_CADENCE).toContain(line)
      expect(DELIVER_BATCH_CADENCE).toContain(line)
    }
  })

  it("bounds a batch inside the transaction itself, and asserts only Top Shot moments move", () => {
    expect(MAX_DELIVERY_BATCH).toBe(50)
    expect(DELIVER_BATCH_CADENCE).toContain("momentIDs.length > 0 && momentIDs.length <= 50")
    expect(DELIVER_BATCH_CADENCE).toContain("momentIDs.length == recipients.length")
    expect(DELIVER_BATCH_CADENCE).toContain("Type<@TopShot.NFT>()")
    expect(DELIVER_GAS_LIMIT).toBe(9999)
  })

  it("the transaction takes exactly the arguments the wallet module sends, in order", () => {
    expect(DELIVER_BATCH_CADENCE).toMatch(
      /transaction\(childAddress: Address, providerControllerID: UInt64, momentIDs: \[UInt64\], recipients: \[Address\]\)/,
    )
  })

  it("the controller lookup only returns controllers the parent can actually resolve", () => {
    expect(PROVIDER_CONTROLLERS_SCRIPT).toContain("getCapability(controllerID: ctl.capabilityID")
    expect(PROVIDER_CONTROLLERS_SCRIPT).toContain("if cap != nil")
  })
})

describe("giveaways/deliver-cadence — moments in the connected Flow Wallet itself (2026-10-03)", () => {
  it("the own transaction and its simulation share the provider borrow and the transfer loop verbatim", () => {
    expect(DELIVER_OWN_BATCH_CADENCE).toContain(BORROW_OWN_PROVIDER)
    expect(DELIVER_OWN_SIMULATION_SCRIPT).toContain(BORROW_OWN_PROVIDER)
    expect(DELIVER_OWN_BATCH_CADENCE).toContain(deliverLoop("self.provider"))
    expect(DELIVER_OWN_SIMULATION_SCRIPT).toContain(deliverLoop("provider"))
  })

  it("withdraws from the SIGNER's own Top Shot collection — no Hybrid Custody leg, no child argument", () => {
    expect(BORROW_OWN_PROVIDER).toContain("owner.storage")
    expect(BORROW_OWN_PROVIDER).toContain("from: /storage/MomentCollection")
    expect(BORROW_OWN_PROVIDER).not.toContain("HybridCustody")
    expect(DELIVER_OWN_BATCH_CADENCE).toContain("transaction(momentIDs: [UInt64], recipients: [Address])")
    expect(DELIVER_OWN_SIMULATION_SCRIPT).toContain("getAuthAccount<auth(BorrowValue) &Account>(ownerAddress)")
    expect(BORROW_OWN_PROVIDER).toContain(`<= ${MAX_DELIVERY_BATCH}`)
  })
})

describe("giveaways/deliver-cadence — LINKED_ACCOUNTS_SCRIPT", () => {
  it("admits a child only on a REDEEMED link, read from the child's own record (an offer is not a link)", () => {
    expect(LINKED_ACCOUNTS_SCRIPT).toContain("getRedeemedStatus(addr: parent) == true")
    expect(LINKED_ACCOUNTS_SCRIPT).toContain("HybridCustody.OwnedAccountPublicPath")
    expect(LINKED_ACCOUNTS_SCRIPT).not.toMatch(/isChildOf/)
    expect(LINKED_ACCOUNTS_SCRIPT).toContain("import HybridCustody from 0xd8a7e05a7ac670c0")
    // names each account and flags a Dapper one by its Dapper Utility Coin receiver (2026-10-03)
    expect(LINKED_ACCOUNTS_SCRIPT).toContain("{Address: [String]}")
    expect(LINKED_ACCOUNTS_SCRIPT).toContain("manager.getChildAccountDisplay(address: child)")
    expect(LINKED_ACCOUNTS_SCRIPT).toContain("/public/dapperUtilityCoinReceiver")
  })
})
