import { describe, it, expect } from "vitest"
import { emptyPoolCopy, savedWalletChains } from "@/lib/trophy-picker-format"
import { detectAddressChain } from "@/lib/address"

// The picker's empty-pool copy (2026-09-27). "None found" is either "owns
// nothing here" or "no wallet saved on this chain"; the second is fixable, so
// the copy says how — but ONLY when the saved-wallet list was actually read.
// Telling someone who HAS a wallet to add one is a false claim about their own
// account, so `null` (unknown) must never produce "you haven't added".

const HAVENT = /haven’t added a|haven’t added a wallet/

describe("emptyPoolCopy", () => {
  it("unknown saved chains never claim a wallet is missing, on any filter", () => {
    for (const chain of [null, "flow", "solana"]) {
      expect(emptyPoolCopy(chain, "X", null)).not.toMatch(/You haven’t added/)
    }
  })

  it("All + no wallets at all → add a wallet (Flow or Solana)", () => {
    const c = emptyPoolCopy(null, "", [])
    expect(c).toMatch(/You haven’t added a wallet yet/)
    expect(c).toMatch(/Dapper/)
    expect(c).toMatch(/Solana/)
  })

  it("All + some wallet saved → generic none-found", () => {
    expect(emptyPoolCopy(null, "", ["flow"])).toMatch(/No owned moments found yet/)
  })

  it("Flow collection + no Flow wallet → add a Dapper wallet, naming the collection", () => {
    const c = emptyPoolCopy("flow", "All Day", ["solana"])
    expect(c).toMatch(/You haven’t added a Flow wallet/)
    expect(c).toMatch(/All Day/)
  })

  it("Flow collection + a Flow wallet → none found, no add-wallet instruction", () => {
    const c = emptyPoolCopy("flow", "All Day", ["flow"])
    expect(c).toMatch(/No All Day Moments found in your saved wallets/)
    expect(c).not.toMatch(HAVENT)
  })

  it("Candy + no Solana wallet → add a Solana wallet", () => {
    expect(emptyPoolCopy("solana", "Candy", ["flow"])).toMatch(/You haven’t added a Solana wallet/)
  })

  it("Candy + a Solana wallet → none in it, no add-wallet instruction", () => {
    const c = emptyPoolCopy("solana", "Candy", ["flow", "solana"])
    expect(c).toBe("No Candy cards in your saved Solana wallet.")
  })
})

describe("savedWalletChains", () => {
  it("maps Cadence to flow and base58 to solana, de-duplicated, without folding case", () => {
    const chains = savedWalletChains(
      ["0xbd94cade097e50ac", "0x1234567890abcdef", "HxnXDTK7zLy7pg2ASW9fVGSD3SRXEEPyvpaSxwbTYqM7"],
      detectAddressChain,
    )
    expect(chains.sort()).toEqual(["flow", "solana"])
  })

  it("an empty list is a known 'no wallets', not unknown", () => {
    expect(savedWalletChains([], detectAddressChain)).toEqual([])
  })
})
