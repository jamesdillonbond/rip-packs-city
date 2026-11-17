import { describe, it, expect } from "vitest"
import {
  BREAK_VALIDATE_RECIPIENTS_TS,
  BREAK_MULTI_TRANSFER_TS,
  BREAK_RANDOM_SOURCE,
} from "@/lib/chains/flow/cadence/break-transactions"

// The v0 pack-breaks Cadence templates — the one remaining ZERO-coverage module
// in the whole lib/ tree. The breaks feature is SHELVED (the `breaks` schema is
// unapplied in prod, the payer wallet is intentionally empty), which is exactly
// why these had no test and exactly why they need a structural pin: nothing
// exercises them, so a bad edit sits undetected until the day someone revives
// the feature and signs a REAL hot-wallet batch transfer with BREAK_MULTI_
// TRANSFER_TS. They are string templates, so the checkable properties are the
// ones CLAUDE.md treats as non-negotiable:
//   - Cadence 1.0 syntax ONLY (auth(...) &Account, never AuthAccount; access(all),
//     never pub);
//   - the deployed mainnet contract addresses (a wrong address is a transaction
//     that fails or, worse, touches the wrong contract);
//   - the invariants the transaction's own safety depends on — the single hot-
//     wallet signer, the withdraw entitlement, and the recipients/momentIds
//     length-match assert.

const ALL = { BREAK_VALIDATE_RECIPIENTS_TS, BREAK_MULTI_TRANSFER_TS, BREAK_RANDOM_SOURCE }

describe("break-transactions — Cadence 1.0 syntax (no pre-1.0 forms)", () => {
  it.each(Object.entries(ALL))("%s uses no AuthAccount and no `pub`", (_name, src) => {
    expect(src).not.toContain("AuthAccount")
    // `pub ` (pre-1.0 access modifier) must not appear; access(all) is the 1.0 form.
    expect(src).not.toMatch(/\bpub\s+(fun|var|let|resource|struct|event|contract)\b/)
  })
})

describe("break-transactions — canonical mainnet addresses", () => {
  it("imports TopShot + NonFungibleToken at their deployed addresses", () => {
    expect(BREAK_VALIDATE_RECIPIENTS_TS).toContain("import TopShot from 0x0b2a3299cc857e29")
    expect(BREAK_VALIDATE_RECIPIENTS_TS).toContain("import NonFungibleToken from 0x1d7e57aa55817448")
    expect(BREAK_MULTI_TRANSFER_TS).toContain("import TopShot from 0x0b2a3299cc857e29")
    expect(BREAK_MULTI_TRANSFER_TS).toContain("import NonFungibleToken from 0x1d7e57aa55817448")
  })
  it("reads the canonical on-chain VRF source (RandomBeaconHistory 0xe467b9dd11fa00df)", () => {
    expect(BREAK_RANDOM_SOURCE).toContain("import RandomBeaconHistory from 0xe467b9dd11fa00df")
    expect(BREAK_RANDOM_SOURCE).toContain("RandomBeaconHistory.sourceOfRandomness(atBlockHeight:")
  })
})

describe("BREAK_VALIDATE_RECIPIENTS_TS — pre-lock capability probe (script)", () => {
  it("is a script that maps [Address] -> [Bool] via the public MomentCollection cap", () => {
    expect(BREAK_VALIDATE_RECIPIENTS_TS).toMatch(/access\(all\)\s+fun\s+main\(addrs:\s*\[Address\]\):\s*\[Bool\]/)
    expect(BREAK_VALIDATE_RECIPIENTS_TS).toContain("borrow<&{NonFungibleToken.CollectionPublic}>(/public/MomentCollection)")
    // it is a read-only script, not a transaction
    expect(BREAK_VALIDATE_RECIPIENTS_TS).not.toContain("transaction(")
  })
})

describe("BREAK_MULTI_TRANSFER_TS — hot-wallet batch transfer (transaction)", () => {
  it("is a single-signer transaction (one &Account, the hot wallet — never a dual-signer)", () => {
    const signerCount = (BREAK_MULTI_TRANSFER_TS.match(/&Account\b/g) || []).length
    expect(signerCount).toBe(1)
    expect(BREAK_MULTI_TRANSFER_TS).toMatch(/prepare\(signer:\s*auth\(BorrowValue\)\s*&Account\)/)
  })

  it("borrows the collection with the Withdraw entitlement (a bare &Collection could not withdraw)", () => {
    expect(BREAK_MULTI_TRANSFER_TS).toContain("auth(NonFungibleToken.Withdraw) &TopShot.Collection")
    expect(BREAK_MULTI_TRANSFER_TS).toContain("from: /storage/MomentCollection")
  })

  it("asserts recipients and momentIds are the same length (the pairing invariant)", () => {
    expect(BREAK_MULTI_TRANSFER_TS).toContain("recipients.length == momentIds.length")
  })

  it("withdraws each moment and deposits to the recipient's public collection", () => {
    expect(BREAK_MULTI_TRANSFER_TS).toContain("self.collection.withdraw(withdrawID: momentIds[i])")
    expect(BREAK_MULTI_TRANSFER_TS).toContain("receiver.deposit(token: <-nft)")
    // a missing recipient capability must panic, not silently drop the moment
    expect(BREAK_MULTI_TRANSFER_TS).toContain("panic(")
  })
})

describe("BREAK_RANDOM_SOURCE — VRF entropy read (script)", () => {
  it("returns the raw entropy bytes ([UInt8]) at a target sealed height", () => {
    expect(BREAK_RANDOM_SOURCE).toMatch(/access\(all\)\s+fun\s+main\(blockHeight:\s*UInt64\):\s*\[UInt8\]/)
    expect(BREAK_RANDOM_SOURCE).toContain("return entry.value")
    expect(BREAK_RANDOM_SOURCE).not.toContain("transaction(")
  })
})
