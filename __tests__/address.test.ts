import { describe, it, expect } from "vitest"
import {
  isCadenceAddress,
  isEvmAddress,
  isSolanaAddress,
  detectAddressChain,
  isSupportedAddress,
  chainKindForDbChain,
  isValidAddressForChain,
  normalizeAddress,
  displayAddress,
  truncateAddressForDisplay,
} from "@/lib/address"

// Chain-aware address validation. The load-bearing footgun: Solana base58 is
// CASE-SENSITIVE, so normalizeAddress must NOT lower-case it (a bare
// .toLowerCase() elsewhere would corrupt the wallet). Pin per-chain shapes +
// the chain dispatch.

const FLOW = "0xbd94cade097e50ac" // 0x + 16 hex
const EVM = "0x" + "a".repeat(40) // 0x + 40 hex
const SOL = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNP" // 38 chars, base58 alphabet

describe("per-chain shape validators", () => {
  it("isCadenceAddress: 0x + exactly 16 hex", () => {
    expect(isCadenceAddress(FLOW)).toBe(true)
    expect(isCadenceAddress("0x123")).toBe(false)
    expect(isCadenceAddress(EVM)).toBe(false)
  })

  it("isEvmAddress: 0x + exactly 40 hex", () => {
    expect(isEvmAddress(EVM)).toBe(true)
    expect(isEvmAddress(FLOW)).toBe(false)
  })

  it("isSolanaAddress: base58 32-44 chars, and never a 0x string", () => {
    expect(isSolanaAddress(SOL)).toBe(true)
    expect(isSolanaAddress(FLOW)).toBe(false) // 0x excluded by base58 alphabet
    expect(isSolanaAddress("tooShort")).toBe(false)
  })
})

describe("detectAddressChain / isSupportedAddress", () => {
  it("classifies each chain and unknown", () => {
    expect(detectAddressChain(FLOW)).toBe("cadence")
    expect(detectAddressChain(EVM)).toBe("evm")
    expect(detectAddressChain(SOL)).toBe("solana")
    expect(detectAddressChain("not-an-address!!")).toBe("unknown")
  })

  it("isSupportedAddress is true for any recognized chain", () => {
    expect(isSupportedAddress(FLOW)).toBe(true)
    expect(isSupportedAddress(SOL)).toBe(true)
    expect(isSupportedAddress("garbage")).toBe(false)
  })
})

describe("chainKindForDbChain", () => {
  it("maps the chain_type enum to an address kind", () => {
    expect(chainKindForDbChain("flow")).toBe("cadence")
    expect(chainKindForDbChain("ethereum")).toBe("evm")
    expect(chainKindForDbChain("polygon")).toBe("evm")
    expect(chainKindForDbChain("flow_evm")).toBe("evm")
    expect(chainKindForDbChain("solana")).toBe("solana")
    expect(chainKindForDbChain(null)).toBeNull()
    expect(chainKindForDbChain("unmapped")).toBeNull()
  })
})

describe("isValidAddressForChain", () => {
  it("validates against the collection's chain shape", () => {
    expect(isValidAddressForChain(FLOW, "flow")).toBe(true)
    expect(isValidAddressForChain(EVM, "flow")).toBe(false)
    expect(isValidAddressForChain(EVM, "ethereum")).toBe(true)
    expect(isValidAddressForChain(SOL, "solana")).toBe(true)
  })

  it("falls back to any-supported-address when the chain is unmapped", () => {
    expect(isValidAddressForChain(FLOW, null)).toBe(true)
    expect(isValidAddressForChain("garbage", null)).toBe(false)
  })
})

describe("normalizeAddress (the case-sensitivity footgun)", () => {
  it("lower-cases hex (Flow / EVM)", () => {
    expect(normalizeAddress("0xBD94CADE097E50AC")).toBe("0xbd94cade097e50ac")
  })

  it("preserves Solana base58 case verbatim", () => {
    expect(normalizeAddress(SOL)).toBe(SOL) // NOT lower-cased
  })

  it("trims surrounding whitespace", () => {
    expect(normalizeAddress("  0xBD94CADE097E50AC  ")).toBe("0xbd94cade097e50ac")
  })
})

// ⛔ THE FOLD-AND-PREFIX FABRICATION, pinned 2026-09-19. Every wallet-display
// helper in this repo was written when every wallet was Flow, so they all
// lowercase the address and prepend `0x` if it is missing. On a Solana mint —
// CASE-SENSITIVE and un-prefixed — that is wrong three ways at once: it claims
// a Flow shape, it is a DIFFERENT address once folded, and it does not exist.
//
// 📏 Measured live before the fix, on /candy-mlb/player/mike-trout and
// /candy-mlb/edition/mike-trout-pink: labels read `0x2at8…jrqw` / `0x1bwu…ndix`
// while the `title=` on the SAME element carried the correct-case
// `AGzqZEJXbYeJze7aba6xTvQRHCt5ENmLhjbXejnzSpcQ`. The element disagreed with
// itself, and a reader copying what they could see got a dead string.
describe("displayAddress / truncateAddressForDisplay", () => {
  const MINT = "AGzqZEJXbYeJze7aba6xTvQRHCt5ENmLhjbXejnzSpcQ"

  it("⚠ the hex path is BYTE-IDENTICAL to the fold-and-prefix it replaces", () => {
    // This is the arm that makes the change safe to land everywhere at once:
    // no Flow surface moves. Delete it and the Solana arms below are satisfied
    // by a function that has quietly changed every Flow label in the product.
    expect(displayAddress("0xABCDEF1234567890")).toBe("0xabcdef1234567890")
    expect(displayAddress("ABCDEF1234567890")).toBe("0xabcdef1234567890")
    expect(truncateAddressForDisplay("0xABCDEF1234567890")).toBe("0xabcd…7890")
    expect(truncateAddressForDisplay("ABCDEF1234567890")).toBe("0xabcd…7890")
  })

  it("⛔ a Solana mint keeps its case and never grows a 0x prefix", () => {
    expect(displayAddress(MINT)).toBe(MINT)
    expect(displayAddress(MINT)).not.toContain("0x")
    expect(displayAddress(MINT)).not.toBe(MINT.toLowerCase())
  })

  it("truncates a mint from its own characters, not from a mangled copy", () => {
    expect(truncateAddressForDisplay(MINT)).toBe(`${MINT.slice(0, 6)}…${MINT.slice(-4)}`)
    expect(truncateAddressForDisplay(MINT)).not.toMatch(/^0x/)
  })

  it("a missing address is an em-dash, never a prefix with nothing after it", () => {
    expect(displayAddress(null)).toBeNull()
    expect(displayAddress("   ")).toBeNull()
    expect(truncateAddressForDisplay(null)).toBe("—")
    expect(truncateAddressForDisplay(undefined, "n/a")).toBe("n/a")
  })

  it("a short hex address is returned whole rather than ellipsised into nonsense", () => {
    expect(truncateAddressForDisplay("0x1234")).toBe("0x1234")
  })
})
