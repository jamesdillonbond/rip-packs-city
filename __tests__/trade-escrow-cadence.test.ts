import { describe, it, expect } from "vitest"
import {
  proposeTradeCadence,
  depositToTradeCadence,
  executeSwapCadence,
  cancelTradeCadence,
  reclaimExpiredCadence,
} from "@/lib/trade-escrow/cadence"

// Unit tests for the RPCTradeEscrow Cadence template builders. These are pure
// string builders — they inject the (env-supplied) contract address and the
// per-collection paths into transaction source. They are UNVERIFIED against a
// deployed contract (RPCTradeEscrow isn't on mainnet), so these tests pin the
// SHAPE we intend to submit, not on-chain behavior: the right contract calls,
// the address injection with a 0x prefix, and the path-literal guard.

const ADDR = "0x1234567890abcdef"

describe("proposeTradeCadence", () => {
  it("imports the escrow at the given address and calls proposeTrade via CompositeType", () => {
    const cdc = proposeTradeCadence(ADDR)
    expect(cdc).toContain(`import RPCTradeEscrow from ${ADDR}`)
    expect(cdc).toContain("RPCTradeEscrow.proposeTrade(")
    expect(cdc).toContain("CompositeType(partyA_nftTypeIdentifier)")
    expect(cdc).toContain("CompositeType(partyB_nftTypeIdentifier)")
    expect(cdc).toContain("proposedBy: proposer.address")
    // expiresAt is a UFix64 arg.
    expect(cdc).toContain("expiresAt: UFix64")
  })

  it("prefixes a bare (no-0x) address", () => {
    expect(proposeTradeCadence("abc123")).toContain("import RPCTradeEscrow from 0xabc123")
  })
})

describe("depositToTradeCadence", () => {
  it("imports NonFungibleToken + escrow, splices all three paths, and calls depositToTrade", () => {
    const cdc = depositToTradeCadence(
      ADDR,
      "/storage/MomentCollection",
      "/public/MomentCollection",
      "/public/AllDayNFTCollection"
    )
    expect(cdc).toContain("import NonFungibleToken from 0x1d7e57aa55817448")
    expect(cdc).toContain(`import RPCTradeEscrow from ${ADDR}`)
    expect(cdc).toContain("from: /storage/MomentCollection")
    // refund receiver at the depositor's own public path
    expect(cdc).toContain("signer.capabilities.get<&{NonFungibleToken.Receiver}>(/public/MomentCollection)")
    // incoming receiver at the OTHER collection's public path
    expect(cdc).toContain("signer.capabilities.get<&{NonFungibleToken.Receiver}>(/public/AllDayNFTCollection)")
    expect(cdc).toContain("RPCTradeEscrow.depositToTrade(")
    expect(cdc).toContain("depositor: signer.address")
    // generic Provider borrow with the Withdraw entitlement — collection-agnostic
    expect(cdc).toContain("auth(NonFungibleToken.Withdraw) &{NonFungibleToken.Provider}")
  })

  it("rejects a malformed / injected path literal", () => {
    expect(() =>
      depositToTradeCadence(ADDR, "/storage/Moment Collection", "/public/X", "/public/Y")
    ).toThrow(/storage path literal/)
    // a quote-injection attempt must be refused
    expect(() =>
      depositToTradeCadence(ADDR, '/storage/X") panic("x', "/public/X", "/public/Y")
    ).toThrow(/storage path literal/)
    // wrong domain
    expect(() =>
      depositToTradeCadence(ADDR, "/private/X", "/public/X", "/public/Y")
    ).toThrow(/storage path literal/)
  })
})

describe("executeSwapCadence / cancelTradeCadence / reclaimExpiredCadence", () => {
  it("execute calls executeSwap with the tradeId arg", () => {
    const cdc = executeSwapCadence(ADDR)
    expect(cdc).toContain("RPCTradeEscrow.executeSwap(tradeId: tradeId)")
    expect(cdc).toContain(`import RPCTradeEscrow from ${ADDR}`)
  })

  it("cancel passes the signer as cancelledBy and carries a reason", () => {
    const cdc = cancelTradeCadence(ADDR)
    expect(cdc).toContain("RPCTradeEscrow.cancelTrade(")
    expect(cdc).toContain("cancelledBy: signer.address")
    expect(cdc).toContain("reason: reason")
  })

  it("reclaim calls reclaimExpired with the tradeId arg", () => {
    const cdc = reclaimExpiredCadence(ADDR)
    expect(cdc).toContain("RPCTradeEscrow.reclaimExpired(tradeId: tradeId)")
  })
})
